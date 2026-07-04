import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { listServersForTeam, assertServerAccessibleTx } from "./servers";
import { getDb } from "../db/client";
import { databases as databasesTable } from "../db/schema/control-plane";
import { assembleDatabase, databaseToRow } from "./backup-rows";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  requireActiveTeamId,
  requireCapability,
  canExposePorts,
} from "../membership";
import { recordActivity } from "./activity";
import { encryptSecret, decryptSecret, randomToken } from "../crypto";
import { connectAgent, mapCheckPortUnsupported } from "../infra/agent-client";
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

// The host-port range the "generate an available port" button draws from when a
// database is exposed publicly. Deliberately HIGH and away from the well-known
// engine ports (5432/3306/…) so a generated port never lands on a system service
// or the control plane's own DB — the exact collision that made "expose publicly"
// silently fail before. Any port in [1024, 65535] a user types is still allowed
// (validated + agent-checked for availability); this range only bounds the
// suggestion.
const EXPOSE_PORT_MIN = 20000;
const EXPOSE_PORT_MAX = 40000;
// A user-supplied port must be a real, unprivileged TCP port. Privileged ports
// (<1024) are rejected: the DB container runs unprivileged and binding them on
// the host is both a footgun and a collision magnet.
const MIN_USER_PORT = 1024;
const MAX_PORT = 65535;

/** Whether a host port is a valid, unprivileged TCP port a user may request. */
function isValidExposePort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_USER_PORT && port <= MAX_PORT;
}

/**
 * Ask the owning server's agent whether a host TCP port is free to publish. The
 * agent binds the port to answer, so this sees BOTH Docker-published ports and any
 * non-Deplo host listener (a system Postgres on 5432, the control plane's own DB).
 * Surfaces {@link import("../infra/agent-client").AgentCheckPortUnsupportedError}
 * when the server's agent is too old to probe ports, so the UI can say "update the
 * agent" rather than silently letting a collision through at provision time.
 */
async function isHostPortFree(serverId: string, port: number): Promise<boolean> {
  const conn = await connectAgent(serverId);
  try {
    const res = await conn.checkPort(port);
    return res.available;
  } catch (e) {
    throw mapCheckPortUnsupported(e);
  } finally {
    conn.close();
  }
}

/**
 * Pick a host port that is currently free on the given server, drawn from the high
 * ephemeral range. Backs the "generate an available port" button. Probes the agent
 * per candidate (a bind test) and returns the first free one; throws if it can't
 * find one in a bounded number of tries (a saturated host — vanishingly unlikely
 * across a 20k-wide range). The port is only a SUGGESTION — creation re-checks it,
 * so a race between suggest and submit is caught there too.
 */
export async function generateAvailableDbPort(input: {
  serverId?: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");
  const servers = await listServersForTeam(teamId);
  if (servers.length === 0) throw new Error("No server available");
  let server;
  if (input.serverId) {
    server = servers.find((s) => s.id === input.serverId);
    if (!server) throw new Error("Selected server not found");
  } else if (servers.length === 1) {
    server = servers[0];
  } else {
    throw new Error("Select a server first");
  }
  if (!server.agent?.certFingerprint)
    throw new Error(`Server ${server.name} is not provisioned yet`);

  // Start at a random offset in the range so repeated clicks (and concurrent
  // callers) don't all probe the same candidate first, then step by a fixed stride
  // to spread the search across the range. A modest cap bounds the agent
  // round-trips; the 20k-wide range dwarfs any realistic set of used host ports, so
  // a free one is found in the first try or two in practice.
  const span = EXPOSE_PORT_MAX - EXPOSE_PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  const MAX_TRIES = 40;
  for (let i = 0; i < MAX_TRIES; i++) {
    const candidate = EXPOSE_PORT_MIN + ((start + i * 733) % span); // stride 733 → good spread across the range
    if (await isHostPortFree(server.id, candidate)) return candidate;
  }
  throw new Error(
    "Could not find a free port on this server automatically. Enter one manually.",
  );
}

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

/** Load one team-scoped database row, assembled, or null. */
async function loadDatabase(
  id: string,
  teamId: string,
): Promise<Database | null> {
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleDatabase(rows[0]) : null;
}

export async function listDatabases(): Promise<DatabaseDTO[]> {
  const teamId = await requireActiveTeamId();
  // Newest-first sort pushed into SQL.
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(eq(databasesTable.teamId, teamId))
    .orderBy(desc(databasesTable.createdAt));
  return rows.map((r) => toDTO(assembleDatabase(r)));
}

export async function getDatabase(id: string): Promise<DatabaseDTO | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(id, teamId);
  return db ? toDTO(db) : null;
}

export async function getConnectionString(id: string): Promise<string> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(id, teamId);
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}

export async function createDatabase(input: {
  name: string;
  type: DatabaseType;
  version: string;
  serverId?: string;
  exposedPublicly?: boolean;
  /**
   * The host port to publish on when {@link exposedPublicly} is true. Required in
   * that case (there is no implicit default — the engine's default port routinely
   * collides on a shared host, which is what made the old "expose publicly"
   * silently fail). Ignored when not exposing.
   */
  exposedPort?: number;
}): Promise<DatabaseDTO> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name) throw new Error("Name is required");

  const exposed = input.exposedPublicly ?? false;
  // Publishing a host port is a privileged action, separate from manage_infra:
  // gate it on the same canExposePorts grant that gates a project's compose
  // `ports:`. Fail BEFORE any work so an unpermitted caller can't create the DB.
  if (exposed && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  // Server selection (Step 0): the caller picks the host; default to the sole
  // server when there is exactly one. The chosen server must exist, be visible
  // to this team (every `all_teams` server + its grants), and be provisioned
  // (have a live agent) — provisioning routes through that agent.
  const servers = await listServersForTeam(teamId);
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

  // Validate + reserve the host port up front when exposing. A collision here is
  // a hard STOP — no container is created — so the operator gets a clear error
  // instead of a half-provisioned DB whose compose-up silently dropped the port
  // bind (the original bug). The agent's bind-probe sees Docker-published ports
  // AND raw host listeners, so this catches a system Postgres on 5432 too.
  let exposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error("A host port is required to expose the database publicly");
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid — choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    if (!(await isHostPortFree(server.id, input.exposedPort)))
      throw new Error(
        `Port ${input.exposedPort} is already in use on ${server.name}. Pick a different port.`,
      );
    exposedPort = input.exposedPort;
  }

  const port = DEFAULT_PORTS[input.type];
  // Service name == container DNS name on the shared `deplo` network == the
  // agent stack slug. Connection strings reference it, so it must stay stable.
  const service = `db-${name}`;
  const password = randomToken(12);
  const user_ = input.type === "redis" ? "default" : "app";
  // The connection host:port depends on reachability. Internal (default): the
  // container's DNS name + engine port, usable only from the deplo network. When
  // exposed publicly: the SERVER's reachable host + the published host port, so the
  // string actually works from outside — the old code always emitted the internal
  // form, so even a correctly-published DB handed out an unusable string.
  const connHost = exposedPort != null ? server.host : service;
  const connPort = exposedPort != null ? exposedPort : port;
  const conn =
    input.type === "redis"
      ? `redis://${user_}:${password}@${connHost}:${connPort}`
      : input.type === "mongodb"
      ? `mongodb://${user_}:${password}@${connHost}:${connPort}/${service}`
      : `${input.type === "mariadb" ? "mysql" : input.type}://${user_}:${password}@${connHost}:${connPort}/${service}`;

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
    exposedPublicly: exposed,
    exposedPort,
    sizeMb: 0,
    createdAt: nowIso(),
  };
  // Re-assert server access inside a tx (SHARE-locks the server row) so a
  // concurrent setServerTeams restrict can't land this database on a server the
  // team just lost access to — pairs with setServerTeams' FOR UPDATE lock.
  await getDb().transaction(async (tx) => {
    await assertServerAccessibleTx(tx, server.id, teamId);
    await tx.insert(databasesTable).values(databaseToRow(db));
  });
  await recordActivity("database", `Created database ${name} (${input.type})`, user.name, null);

  // Provision the real container on the owning server's agent in the background;
  // flips to running/error.
  void provisionDatabase(db.id, server.id, {
    service,
    type: input.type,
    version: input.version,
    password,
    hostPort: exposedPort ?? undefined,
  }).catch(async () => {
    // Mark the row errored — but only if it still exists (a concurrent delete may
    // have raced the floated provision; an UPDATE matching no row is a safe no-op).
    await getDb()
      .update(databasesTable)
      .set({ status: "error" })
      .where(eq(databasesTable.id, db.id));
  });

  return toDTO(db);
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
    /** The validated host port to publish, or undefined for an unexposed DB. */
    hostPort?: number;
  },
): Promise<void> {
  const yaml = generateDatabaseCompose({
    name: opts.service,
    type: opts.type,
    version: opts.version,
    password: opts.password,
    hostPort: opts.hostPort,
  });
  // Run the provision under the DB's lifecycle lock so a concurrent delete can't
  // interleave: a delete issued during provisioning WAITS here, then tears down a
  // fully-created stack (no orphan). If the row was already deleted before we even
  // acquired the lock, there is nothing to provision — bail without creating a
  // stack the control plane no longer tracks.
  await withKeyedLock(id, async () => {
    if (!(await databaseExists(id))) return; // deleted before us
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
    // A single UPDATE; if the row was deleted while the agent provisioned (under
    // the lock this can't happen, but the UPDATE is a safe no-op regardless).
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
  });
}

/** Whether a database row still exists (id-only existence probe, not team-scoped). */
async function databaseExists(id: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(eq(databasesTable.id, id))
    .limit(1);
  return rows.length > 0;
}

export async function setDatabaseRunning(
  id: string,
  running: boolean
): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const db = await loadDatabase(id, teamId);
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
    const cur = await loadDatabase(id, teamId);
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
    await getDb()
      .update(databasesTable)
      .set({ status: running ? "running" : "stopped" })
      .where(eq(databasesTable.id, id));
  });
}

export async function deleteDatabase(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const db = await loadDatabase(id, membership.teamId);
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
    if (!(await databaseExists(id))) return;
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
    // One DELETE — the agent teardown above ran OUTSIDE any transaction (PLAN §1
    // rule (a)). The `backups.database_id` FK CASCADE removes dependent backup
    // SCHEDULES automatically (was a manual `d.backups` filter); `backup_runs`'
    // `database_id` is SET NULL so run history outlives the deleted database.
    await getDb().delete(databasesTable).where(eq(databasesTable.id, id));
    await recordActivity(
      "database",
      orphanWarning
        ? `Deleted database ${db.name} (warning: ${orphanWarning})`
        : `Deleted database ${db.name}`,
      user.name,
      null,
    );
  });
}
