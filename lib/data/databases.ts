import "server-only";

import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, randomToken } from "../crypto";
import { ensureNetwork, docker } from "../infra/docker";
import { generateDatabaseCompose } from "../deploy/compose";
import type { Database, DatabaseType } from "../types";

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const DB_STACK_DIR = join(DATA_DIR, "stacks");
const dbStackFile = (service: string) => join(DB_STACK_DIR, `${service}.yml`);

export interface DatabaseDTO extends Omit<Database, "connectionStringEnc"> {
  connectionStringMasked: string;
}

const DEFAULT_PORTS: Record<DatabaseType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mongodb: 27017,
  redis: 6379,
  clickhouse: 8123,
};

/**
 * Mask the password in a connection string. Fails CLOSED: any string we can't
 * confidently parse is fully redacted rather than risk leaking the secret.
 */
function maskConnectionString(conn: string): string {
  const FULL_MASK = "••••••••••••";
  try {
    const u = new URL(conn);
    if (!u.password) return conn; // nothing secret to hide
    const userPart = u.username ? `${u.username}:••••••@` : "••••••@";
    return `${u.protocol}//${userPart}${u.host}${u.pathname}`;
  } catch {
    return FULL_MASK;
  }
}

function toDTO(db: Database): DatabaseDTO {
  const { connectionStringEnc, ...rest } = db;
  return {
    ...rest,
    connectionStringMasked: maskConnectionString(decryptSecret(connectionStringEnc)),
  };
}

export async function listDatabases(): Promise<DatabaseDTO[]> {
  await assertUser();
  return read()
    .databases.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

export async function getDatabase(id: string): Promise<DatabaseDTO | null> {
  await assertUser();
  const db = read().databases.find((x) => x.id === id);
  return db ? toDTO(db) : null;
}

export async function getConnectionString(id: string): Promise<string> {
  await assertUser();
  const db = read().databases.find((x) => x.id === id);
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}

export async function createDatabase(input: {
  name: string;
  type: DatabaseType;
  version: string;
  exposedPublicly?: boolean;
}): Promise<DatabaseDTO> {
  const user = await assertUser();
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name) throw new Error("Name is required");
  const server = read().servers[0];
  if (!server) throw new Error("No server available");
  const port = DEFAULT_PORTS[input.type];
  // Service name == container DNS name on the shared `deplo` network.
  const service = `db-${name}`;
  const password = randomToken(12);
  const user_ = input.type === "redis" ? "default" : "app";
  const conn =
    input.type === "redis"
      ? `redis://${user_}:${password}@${service}:${port}`
      : input.type === "mongodb"
      ? `mongodb://${user_}:${password}@${service}:${port}/${service}`
      : `${input.type === "mariadb" ? "mysql" : input.type}://${user_}:${password}@${service}:${port}/${service}`;

  const db: Database = {
    id: newId("db"),
    name,
    type: input.type,
    version: input.version,
    status: "provisioning",
    serverId: server.id,
    host: service,
    port,
    connectionStringEnc: encryptSecret(conn),
    exposedPublicly: input.exposedPublicly ?? false,
    sizeMb: 0,
    createdAt: nowIso(),
  };
  mutate((d) => d.databases.push(db));
  recordActivity("database", `Created database ${name} (${input.type})`, user.name, null);

  // Provision the real container in the background; flips to running/error.
  void provisionDatabase(db.id, {
    service,
    type: input.type,
    version: input.version,
    password,
    exposePort: input.exposedPublicly ?? false,
  }).catch(() => {
    mutate((d) => {
      const x = d.databases.find((y) => y.id === db.id);
      if (x) x.status = "error";
    });
  });

  return toDTO(read().databases.find((x) => x.id === db.id)!);
}

async function provisionDatabase(
  id: string,
  opts: {
    service: string;
    type: DatabaseType;
    version: string;
    password: string;
    exposePort: boolean;
  },
): Promise<void> {
  await mkdir(DB_STACK_DIR, { recursive: true });
  await ensureNetwork("deplo");
  const yaml = generateDatabaseCompose({
    name: opts.service,
    type: opts.type,
    version: opts.version,
    password: opts.password,
    exposePort: opts.exposePort,
  });
  const file = dbStackFile(opts.service);
  await writeFile(file, yaml);
  await docker(
    ["compose", "-p", `deplo-${opts.service}`, "-f", file, "up", "-d"],
    { timeout: 600_000 },
  );
  mutate((d) => {
    const db = d.databases.find((x) => x.id === id);
    if (db) db.status = "running";
  });
}

export async function setDatabaseRunning(
  id: string,
  running: boolean
): Promise<void> {
  await assertUser();
  const db = read().databases.find((x) => x.id === id);
  if (!db) throw new Error("Not found");
  const file = dbStackFile(db.host);
  // Let a real docker failure surface to the caller; only update state on success.
  await docker(
    ["compose", "-p", `deplo-${db.host}`, "-f", file, running ? "start" : "stop"],
    { timeout: 60_000 },
  );
  mutate((d) => {
    const x = d.databases.find((y) => y.id === id);
    if (x) x.status = running ? "running" : "stopped";
  });
}

export async function deleteDatabase(id: string): Promise<void> {
  const user = await assertUser();
  const db = read().databases.find((x) => x.id === id);
  if (!db) throw new Error("Not found");
  // Tear down the real container + volume.
  const file = dbStackFile(db.host);
  await docker(
    ["compose", "-p", `deplo-${db.host}`, "-f", file, "down", "-v"],
    { timeout: 60_000 },
  ).catch(() => {});
  await rm(file, { force: true }).catch(() => {});
  mutate((d) => {
    d.databases = d.databases.filter((x) => x.id !== id);
    d.backups = d.backups.filter((b) => b.databaseId !== id);
  });
  recordActivity("database", `Deleted database ${db.name}`, user.name, null);
}
