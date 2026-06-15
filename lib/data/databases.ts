import "server-only";

import { read, mutate } from "../store";
import { newId, nowIso } from "../ids";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, randomToken } from "../crypto";
import type { Database, DatabaseType } from "../types";

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
  const port = DEFAULT_PORTS[input.type];
  const host = `db-${name}.internal`;
  const password = randomToken(12);
  const user_ = input.type === "redis" ? "default" : "app";
  const conn =
    input.type === "redis"
      ? `redis://${user_}:${password}@${host}:${port}`
      : input.type === "mongodb"
      ? `mongodb://${user_}:${password}@${host}:${port}/${name}`
      : `${input.type === "mariadb" ? "mysql" : input.type}://${user_}:${password}@${host}:${port}/${name}`;

  const db: Database = {
    id: newId("db"),
    name,
    type: input.type,
    version: input.version,
    status: "provisioning",
    serverId: server.id,
    host,
    port,
    connectionStringEnc: encryptSecret(conn),
    exposedPublicly: input.exposedPublicly ?? false,
    sizeMb: 0,
    createdAt: nowIso(),
  };
  mutate((d) => d.databases.push(db));
  // Simulate provisioning completing.
  mutate((d) => {
    const found = d.databases.find((x) => x.id === db.id)!;
    found.status = "running";
  });
  recordActivity("database", `Created database ${name} (${input.type})`, user.name, null);
  return toDTO(read().databases.find((x) => x.id === db.id)!);
}

export async function setDatabaseRunning(
  id: string,
  running: boolean
): Promise<void> {
  await assertUser();
  mutate((d) => {
    const db = d.databases.find((x) => x.id === id);
    if (!db) throw new Error("Not found");
    db.status = running ? "running" : "stopped";
  });
}

export async function deleteDatabase(id: string): Promise<void> {
  const user = await assertUser();
  const db = read().databases.find((x) => x.id === id);
  if (!db) throw new Error("Not found");
  mutate((d) => {
    d.databases = d.databases.filter((x) => x.id !== id);
    d.backups = d.backups.filter((b) => b.databaseId !== id);
  });
  recordActivity("database", `Deleted database ${db.name}`, user.name, null);
}
