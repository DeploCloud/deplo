import "server-only";

import { read, mutate } from "../store";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, randomToken } from "../crypto";
import { connectAgent } from "../infra/agent-client";
import { generateDatabaseCompose } from "../deploy/database-compose";
import { withKeyedLock } from "./keyed-mutex";
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
  const teamId = await requireActiveTeamId();
  return read()
    .databases.filter((d) => d.teamId === teamId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .map(toDTO);
}

export async function getDatabase(id: string): Promise<DatabaseDTO | null> {
  const teamId = await requireActiveTeamId();
  const db = read().databases.find((x) => x.id === id && x.teamId === teamId);
  return db ? toDTO(db) : null;
}

export async function getConnectionString(id: string): Promise<string> {
  const teamId = await requireActiveTeamId();
  const db = read().databases.find((x) => x.id === id && x.teamId === teamId);
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}

export async function createDatabase(input: {
  name: string;
  type: DatabaseType;
  version: string;
  serverId?: string;
  exposedPublicly?: boolean;
}): Promise<DatabaseDTO> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name) throw new Error("Name is required");

  // Server selection (Step 0): the caller picks the host; default to the sole
  // server when there is exactly one. The chosen server must exist and be
  // provisioned (have a live agent) — provisioning routes through that agent.
  const servers = read().servers;
  if (servers.length === 0) throw new Error("No server available");
  let server;
  if (input.serverId) {
    server = servers.find((s) => s.id === input.serverId);
    if (!server) throw new Error("Selected server not found");
  } else if (servers.length === 1) {
    server = servers[0];
  } else {
    throw new Error("Select a server to provision the database on");
  }
  if (!server.agent?.certFingerprint)
    throw new Error(
      `Server ${server.name} is not provisioned yet — finish provisioning it before creating a database there`,
    );

  const port = DEFAULT_PORTS[input.type];
  // Service name == container DNS name on the shared `deplo` network == the
  // agent stack slug. Connection strings reference it, so it must stay stable.
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
    teamId,
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

  // Provision the real container on the owning server's agent in the background;
  // flips to running/error.
  void provisionDatabase(db.id, server.id, {
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

/**
 * Provision the DB stack on the owning server's agent. Reuses `Reroute`, which
 * is already a "provision stack" primitive: it writes `<stackDir>/<slug>.yml`
 * and `docker compose -p deplo-<slug> up -d --remove-orphans` idempotently
 * (creating it if absent). No local docker / stack file — the stack lives on the
 * agent's host now (Step 0). The DB keeps its `db-<name>` DNS name on the shared
 * `deplo` network, so connection strings are unchanged.
 */
async function provisionDatabase(
  id: string,
  serverId: string,
  opts: {
    service: string;
    type: DatabaseType;
    version: string;
    password: string;
    exposePort: boolean;
  },
): Promise<void> {
  const yaml = generateDatabaseCompose({
    name: opts.service,
    type: opts.type,
    version: opts.version,
    password: opts.password,
    exposePort: opts.exposePort,
  });
  // Run the provision under the DB's lifecycle lock so a concurrent delete can't
  // interleave: a delete issued during provisioning WAITS here, then tears down a
  // fully-created stack (no orphan). If the row was already deleted before we even
  // acquired the lock, there is nothing to provision — bail without creating a
  // stack the control plane no longer tracks.
  await withKeyedLock(id, async () => {
    if (!read().databases.some((x) => x.id === id)) return; // deleted before us
    const conn = await connectAgent(serverId);
    try {
      const res = await conn.reroute({
        slug: opts.service,
        composeYaml: yaml,
        env: {},
        mounts: [],
      });
      if (!res.ok) throw new Error(res.error || "agent failed to provision the database");
    } finally {
      conn.close();
    }
    mutate((d) => {
      const db = d.databases.find((x) => x.id === id);
      if (db) db.status = "running";
    });
  });
}

export async function setDatabaseRunning(
  id: string,
  running: boolean
): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const db = read().databases.find((x) => x.id === id && x.teamId === teamId);
  if (!db) throw new Error("Not found");
  const host = db.host;
  const serverId = db.serverId;
  // Serialize on the DB's lifecycle lock: a start/stop issued during provisioning
  // WAITS for the provision to finish rather than racing its status write or
  // hitting a not-yet-created compose project. Everything that touches the agent +
  // writes status happens inside the lock so there is no last-writer-wins window.
  await withKeyedLock(id, async () => {
    // Re-read under the lock — the DB may have been deleted, or just finished
    // provisioning, while we waited our turn.
    const cur = read().databases.find((x) => x.id === id && x.teamId === teamId);
    if (!cur) throw new Error("Not found");
    // The compose project doesn't exist until provisioning finishes, so start/stop
    // against a still-provisioning DB would fail on the agent with a confusing
    // "agent failed to…". Gate on the fresh status — idiomatic here (dev.ts/
    // members.ts). (After waiting behind a provision this reads "running", so a
    // queued start/stop proceeds correctly rather than being rejected.)
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning — wait for it to finish before starting or stopping it.",
      );
    // Lifecycle routes through the owning server's agent. Let a real failure
    // surface to the caller; only update state on success.
    const conn = await connectAgent(serverId);
    try {
      const res = running
        ? await conn.startStack(host)
        : await conn.stopStack(host);
      if (!res.ok)
        throw new Error(res.error || `agent failed to ${running ? "start" : "stop"} the database`);
    } finally {
      conn.close();
    }
    mutate((d) => {
      const x = d.databases.find((y) => y.id === id);
      if (x) x.status = running ? "running" : "stopped";
    });
  });
}

export async function deleteDatabase(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const db = read().databases.find(
    (x) => x.id === id && x.teamId === membership.teamId,
  );
  if (!db) throw new Error("Not found");
  // Serialize the whole teardown on the DB's lifecycle lock. The race this closes:
  // createDatabase fires provisionDatabase (`compose up -d`) as a floated task, so
  // without the lock a delete could run `down -v` and remove the row while that
  // provision is still in flight — the provision's `up -d` then recreates the
  // container + volume the control plane no longer tracks. Under the lock a delete
  // WAITS for the provision, then tears down a fully-created stack.
  await withKeyedLock(id, async () => {
    // Re-check under the lock: a concurrent delete (or never-finished provision
    // that bailed) may have already removed the row. Idempotent → just return.
    if (!read().databases.some((x) => x.id === id)) return;
    // Tear down the real container + data volume on the owning agent via
    // `removeVolumes` (`down -v` + remove the compose file). Best-effort: we still
    // remove the row (the operator asked to delete it) even when the volume could
    // not be reclaimed, but we surface that so it isn't a silent leak. Two ways the
    // volume can survive:
    //   - the agent reports ok:false — its `down -v` failed and it fell through to
    //     `rm -f` (which can't reclaim a named volume), or the agent is too old to
    //     honour removeVolumes and only ran a plain `down`;
    //   - the host is unreachable (the dial/RPC throws).
    // Both leave an orphaned volume to sweep by hand; record it on the activity log
    // so it has a durable trace, not just a process log.
    let orphanWarning: string | null = null;
    try {
      const conn = await connectAgent(db.serverId);
      try {
        const r = await conn.destroyStack(db.host, true);
        if (!r.ok)
          orphanWarning =
            `Agent did not cleanly tear down ${db.host} (${r.error || "unknown error"}). ` +
            `Its data volume may be orphaned — sweep it on the host with ` +
            `\`docker volume rm\`.`;
      } finally {
        conn.close();
      }
    } catch (e) {
      orphanWarning =
        `Could not reach the agent on this database's server to tear it down ` +
        `(${e instanceof Error ? e.message : String(e)}). Its container/volume may ` +
        `need a manual cleanup on the host.`;
    }
    if (orphanWarning) console.warn(`[databases] ${orphanWarning}`);
    mutate((d) => {
      d.databases = d.databases.filter((x) => x.id !== id);
      d.backups = d.backups.filter((b) => b.databaseId !== id);
    });
    recordActivity(
      "database",
      orphanWarning
        ? `Deleted database ${db.name} (warning: ${orphanWarning})`
        : `Deleted database ${db.name}`,
      user.name,
      null,
    );
  });
}
