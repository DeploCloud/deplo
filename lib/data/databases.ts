import "server-only";

import { and, desc, eq } from "drizzle-orm";

import { listServersForTeam, assertServerAccessibleTx } from "./servers";
import { getDb } from "../db/client";
import { databases as databasesTable } from "../db/schema/control-plane";
import { assembleDatabase, databaseToRow } from "./backup-rows";
import { cleanResourceLimits, type ResourceLimitsInput } from "./apps";
import { resourceLimitsToRow } from "./app-graph-rows";
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
import {
  migrateWorkloadData,
  stopStackOn,
  startStackOn,
  destroyStackOn,
} from "./volume-migration";
import {
  generateDatabaseCompose,
  buildConnectionString,
  parseConnectionPassword,
  effectiveDatabaseImage,
} from "../deploy/database-compose";
import { isDockerLevelStderr } from "../infra/docker";
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

/** The engine login used when the caller doesn't supply a custom username —
 *  matches the historical per-engine hardcode (redis 'default', else 'app'). */
function defaultUserFor(type: DatabaseType): string {
  return type === "redis" ? "default" : "app";
}

/**
 * Sanitize a user-supplied engine identifier (DB user or DB name) to a portable,
 * URL-safe SQL identifier: lowercased, `[a-z0-9_]`, starting with a letter or
 * underscore. Returns null when the cleaned value is empty or leads with a digit
 * so the caller can fall back to the engine default rather than emit a broken
 * identifier. Deliberately NOT the same rule as the service `name` (which allows
 * hyphens for DNS): a hyphen is not a legal unquoted SQL identifier character for
 * a role/database in postgres/mysql, and the value rides raw inside a
 * connection-string URL, so we keep it to `_`.
 */
function sanitizeDbIdentifier(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!cleaned || /^[0-9]/.test(cleaned)) return null;
  return cleaned.slice(0, 63); // postgres identifier limit; also under mysql's 64
}

/**
 * Reject a user-supplied password that can't ride raw inside the connection-string
 * URL and the compose env-file. The password is stored ONLY inside the connection
 * string (parsed back out by `parseConnectionPassword`, which `decodeURIComponent`s
 * it) and is also emitted as a bare `- KEY=value` compose env line, so any of these
 * would corrupt one or both: URL-authority delimiters (`@ / : ? #`), a lone `%`
 * (breaks `decodeURIComponent` → an empty dump password → a silently failing
 * backup), YAML/env-file hazards (`$` interpolation, backslash, backtick, brackets),
 * and whitespace/control chars. `randomToken`'s output is URL-safe base64url, so the
 * auto-generated default always passes.
 */
function assertPasswordSafe(password: string): void {
  if (/[@/:?#%$\\`[\]\s]/.test(password))
    throw new Error(
      "Password may not contain @ / : ? # % $ \\ ` [ ] or whitespace",
    );
}

/**
 * Resolve the server a team may provision/reroute a database on: it must exist,
 * be visible to the team (an `all_teams` server or one granted to it), and be
 * provisioned (have a live agent). Defaults to the sole server when there is
 * exactly one and none was named. Throws a caller-facing error otherwise. Shared
 * by createDatabase, generateAvailableDbPort, and updateDatabase so the three
 * paths can't drift on what "a usable server" means.
 */
async function resolveTeamServer(teamId: string, serverId?: string) {
  const servers = await listServersForTeam(teamId);
  if (servers.length === 0) throw new Error("No server available");
  let server;
  if (serverId) {
    server = servers.find((s) => s.id === serverId);
    if (!server) throw new Error("Selected server not found");
  } else if (servers.length === 1) {
    server = servers[0];
  } else {
    throw new Error("Select a server first");
  }
  if (!server.agent?.certFingerprint)
    throw new Error(`Server ${server.name} is not provisioned yet`);
  return server;
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
  const server = await resolveTeamServer(teamId, input.serverId);

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

/**
 * Load one team-scoped database row, assembled, or null. Exported (cookie-free —
 * the caller supplies the teamId) as the seam the `databaseStatus` subscription
 * generator and `lib/data/database-console.ts` resolve through, mirroring
 * `loadTeamApp` in apps.ts.
 */
export async function loadDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<Database | null> {
  return loadDatabase(id, teamId);
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
  /**
   * The engine login to create. Optional — falls back to the engine default
   * (`app`, or `default` for redis). Sanitized to a portable SQL identifier.
   * Forced to `default` for redis (there is no mechanism to create a redis ACL
   * user, so any override would emit an unusable connection string). Create-only:
   * the images apply it only on first init against an empty volume.
   */
  username?: string;
  /**
   * The logical database to create. Optional — falls back to the service name
   * (`db-<name>`), which is what databases created before this input always used,
   * so backups keep dumping the identical database. Sanitized like {@link username}.
   */
  dbName?: string;
  /**
   * The engine password. Optional — falls back to an auto-generated URL-safe
   * token. A supplied password is validated for URL/env-file safety. Stored only
   * inside the encrypted connection string (never a column, never returned).
   */
  password?: string;
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
  // Validate a supplied password up front — it is cheap, local input validation,
  // so fail fast (before any server lookup or agent probe) with a clear message
  // rather than surfacing it only after slower checks.
  if (input.password) assertPasswordSafe(input.password);

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
  const server = await resolveTeamServer(teamId, input.serverId);

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
  // App name == container DNS name on the shared `deplo` network == the
  // agent stack slug. Connection strings reference it, so it must stay stable.
  const service = `db-${name}`;

  // Resolve the credentials. Redis has no user concept (auth is a single
  // requirepass and the built-in ACL user is literally `default`), so its
  // username is forced regardless of any override — a custom name would emit a
  // connection string that authenticates as a redis ACL user that was never
  // created. The logical DB defaults to the service name (today's behavior), so
  // the compose `*_DB` env, the connection-string path, and the backup dump
  // target all stay `db-<name>` for a default create.
  const username =
    input.type === "redis"
      ? "default"
      : (input.username ? sanitizeDbIdentifier(input.username) : null) ??
        defaultUserFor(input.type);
  const dbName =
    (input.dbName ? sanitizeDbIdentifier(input.dbName) : null) ?? service;
  const password =
    input.password && input.password.length > 0
      ? input.password
      : randomToken(12);

  // The connection host:port depends on reachability. Internal (default): the
  // container's DNS name + engine port, usable only from the deplo network. When
  // exposed publicly: the SERVER's reachable host + the published host port, so the
  // string actually works from outside — the old code always emitted the internal
  // form, so even a correctly-published DB handed out an unusable string.
  const conn = buildConnectionString({
    type: input.type,
    username,
    password,
    host: exposedPort != null ? server.host : service,
    port: exposedPort != null ? exposedPort : port,
    dbName,
  });

  const db: Database = {
    id: newId("db"),
    teamId,
    name,
    type: input.type,
    version: input.version,
    username,
    dbName,
    status: "provisioning",
    serverId: server.id,
    host: service,
    port,
    connectionStringEnc: encryptSecret(conn),
    exposedPublicly: exposed,
    exposedPort,
    resources: null,
    customImage: null,
    customCommand: null,
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
  void provisionDatabase(db, password).catch(async () => {
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
 * The ONE render call for a database's compose stack. Every path that ships
 * YAML to the agent (initial provision, exposure edit / server move, redeploy)
 * goes through here, reading everything — exposure, resource limits, image /
 * command overrides — from the {@link Database} object, so the renders can't
 * drift and "the row is truth": any reroute applies the row's pending edits.
 */
function renderDatabaseStackYaml(db: Database, password: string): string {
  return generateDatabaseCompose({
    name: db.host, // service slug, stable
    databaseId: db.id,
    type: db.type,
    version: db.version,
    username: db.username,
    password,
    dbName: db.dbName,
    hostPort:
      db.exposedPublicly && db.exposedPort != null ? db.exposedPort : undefined,
    resources: db.resources,
    customImage: db.customImage,
    customCommand: db.customCommand,
  });
}

/**
 * Provision the DB stack on the owning server's agent. Reuses `Reroute`, which
 * is already a "provision stack" primitive: it writes `<stackDir>/<slug>.yml`
 * and `docker compose -p deplo-<slug> up -d --remove-orphans` idempotently
 * (creating it if absent). No local docker / stack file — the stack lives on the
 * agent's host now (Step 0). The DB keeps its `db-<name>` DNS name on the shared
 * `deplo` network, so connection strings are unchanged.
 */
async function provisionDatabase(db: Database, password: string): Promise<void> {
  const yaml = renderDatabaseStackYaml(db, password);
  // Run the provision under the DB's lifecycle lock so a concurrent delete can't
  // interleave: a delete issued during provisioning WAITS here, then tears down a
  // fully-created stack (no orphan). If the row was already deleted before we even
  // acquired the lock, there is nothing to provision — bail without creating a
  // stack the control plane no longer tracks.
  await withKeyedLock(db.id, async () => {
    if (!(await databaseExists(db.id))) return; // deleted before us
    const conn = await connectAgent(db.serverId);
    try {
      const res = await conn.reroute({
        slug: db.host,
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
      .where(eq(databasesTable.id, db.id));
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

/**
 * The host-side Docker volume name of a database's data volume. The DB compose
 * declares the volume as `<slug>-data` with NO `name:` override (see
 * generateDatabaseCompose), so Docker Compose prefixes it with the project name
 * (`-p deplo-<slug>`) → `deplo-<slug>_<slug>-data`. This is the exact string the
 * agent's ExportVolume/ImportVolume operate on. Matches the compose-stack
 * convention `composeStackVolumeHostNames` uses for projects (`deplo-<slug>_<key>`).
 */
export function dbVolumeHostName(slug: string): string {
  return `deplo-${slug}_${slug}-data`;
}

/**
 * Edit a database's public exposure (publish/unpublish + host port) and,
 * optionally, the SERVER it runs on. The engine, username and db name are
 * create-only — the official images apply those env vars only on first init
 * against an empty volume, so changing them would be a silent no-op or data
 * loss. Version / image / command edits live in {@link updateDatabaseImage},
 * resource limits in {@link updateDatabaseResources}, password rotation in
 * {@link rotateDatabasePassword}.
 *
 * Two shapes of edit, both routed through the same lock and status gates:
 *
 *  - In-place (server unchanged): re-render the compose and reroute the container
 *    on its current host (`up -d --remove-orphans`), which PRESERVES the named data
 *    volume; the only material change to the rendered YAML is the `ports:` block.
 *
 *  - Move to a different server: the container is provisioned fresh on the new host,
 *    then the data volume is COPIED host-to-host (relayed through the control plane
 *    via the agent ExportVolume/ImportVolume RPCs — no S3), then the old host's
 *    stack is torn down. So the data FOLLOWS the move. The sequence is: reroute on
 *    the new host → stop BOTH stacks (destination so nothing writes the volume mid-
 *    import, source for a consistent read) → copy the volume → start the new stack →
 *    destroy the old. The old stack is only destroyed AFTER a verified successful
 *    copy, so a copy failure ROLLS BACK (the half-built new stack is removed, the
 *    old one restarted) and the original is left intact with its data.
 *
 * Because the connection string embeds a host:port that depends on reachability
 * (the internal service name + engine port when unexposed, the server's host +
 * published port when exposed), toggling exposure OR moving servers INVALIDATES the
 * stored string — so it is re-derived and re-encrypted here, around the UNCHANGED
 * create-only password recovered from the old string. The `host`/`port`/`username`/
 * `dbName` columns are untouched (the container's DNS identity and credentials are
 * fixed at first init and don't move).
 */
export async function updateDatabase(
  id: string,
  input: {
    exposedPublicly: boolean;
    exposedPort?: number;
    /**
     * Move the database to this server. Optional — omitted (or equal to the current
     * server) keeps it in place. Must be a server visible to the team and
     * provisioned (resolved via {@link resolveTeamServer}, same guard as create).
     * A move recreates the container on the new host WITHOUT its data (see above).
     */
    serverId?: string;
  },
): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const db = await loadDatabase(id, teamId);
  if (!db) throw new Error("Not found");

  const exposed = input.exposedPublicly;
  // Same privileged gate as create: publishing a port requires the canExposePorts
  // grant, checked here (not as a GraphQL authScope) because it only applies when
  // exposure is being turned ON. Fail BEFORE any agent work.
  if (exposed && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  // Resolve the TARGET server through the team's visible set: a move can only land
  // on a server this team may use, and an in-place edit re-resolves the current one
  // so a team that LOST access to it can't reroute onto it. Also yields the host
  // for the re-derived connection string when exposed. Default (no serverId) keeps
  // the current server.
  const targetServer = await resolveTeamServer(
    teamId,
    input.serverId ?? db.serverId,
  );
  // The old host we tear down after a successful move. Non-null only on a move.
  const movingFrom = targetServer.id !== db.serverId ? db.serverId : null;

  // Validate the new exposed port, mirroring create. The bind-probe runs against
  // the TARGET server. Skip it only for a true self-collision — the DB is ALREADY
  // exposed on this exact port on the SAME host we're staying on; on a MOVE the
  // port must be re-probed on the new host (it may be taken there even if free
  // here), so the self-reuse shortcut must not apply.
  let newExposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error("A host port is required to expose the database publicly");
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid — choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    const reusingOwnPort =
      !movingFrom &&
      db.exposedPublicly &&
      db.exposedPort === input.exposedPort;
    if (
      !reusingOwnPort &&
      !(await isHostPortFree(targetServer.id, input.exposedPort))
    )
      throw new Error(
        `Port ${input.exposedPort} is already in use on ${targetServer.name}. Pick a different port.`,
      );
    newExposedPort = input.exposedPort;
  }

  // No-op short-circuit: nothing changed — same server, same exposure — so skip a
  // pointless reroute (a container recreate) and status churn. A MOVE is never a
  // no-op (the container physically relocates), so it always falls through.
  if (
    !movingFrom &&
    db.exposedPublicly === exposed &&
    db.exposedPort === newExposedPort
  )
    return;

  // Re-derive the connection string around the UNCHANGED create-only password.
  // The password is never regenerated on an edit — the running container's
  // credentials are fixed at first init — so recover it from the old string. When
  // exposed the host is the TARGET server's (a move changes it); when internal it
  // is the stable service DNS name, unaffected by a move (same `deplo` network).
  const password = parseConnectionPassword(decryptSecret(db.connectionStringEnc));
  const conn = buildConnectionString({
    type: db.type,
    username: db.username,
    password,
    host: newExposedPort != null ? targetServer.host : db.host,
    port: newExposedPort != null ? newExposedPort : db.port,
    dbName: db.dbName,
  });
  const connEnc = encryptSecret(conn);

  // The reroute + teardown + row write happen under the DB's lifecycle lock, the
  // SAME lock create/start-stop/delete use: an edit issued during provisioning
  // WAITS, then reroutes a now-running DB; a delete issued during an edit WAITS for
  // the reroute/teardown, then tears down the fully-rerouted stack (no orphan).
  let moveWarning: string | null = null;
  await withKeyedLock(id, async () => {
    // Re-read under the lock — the DB may have been deleted, or just finished
    // provisioning, while we waited our turn.
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    // The compose project doesn't exist until provisioning finishes, so a reroute
    // against a still-provisioning DB would fail confusingly. Gate on the fresh
    // status (same reasoning as setDatabaseRunning).
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning — wait for it to finish before editing it.",
      );
    // Render from the FRESH row (with the new exposure overlaid) so the reroute
    // also applies any pending row edits — resource limits, image/command
    // overrides — saved since the pre-lock read ("the row is truth").
    const yaml = renderDatabaseStackYaml(
      { ...cur, exposedPublicly: exposed, exposedPort: newExposedPort },
      password,
    );
    // Provision on the TARGET server first. On a move this creates the stack fresh
    // on the new host (empty volume, ready to receive the copied data); in place it
    // reroutes the existing container. Doing this BEFORE any old-host teardown means
    // a failed reroute leaves the original stack untouched.
    const agent = await connectAgent(targetServer.id);
    try {
      const res = await agent.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: [],
      });
      if (!res.ok)
        throw new Error(res.error || "agent failed to update the database");
    } finally {
      agent.close();
    }

    if (movingFrom) {
      // MOVE: migrate the data volume from the old host to the new one, then tear
      // down the old. The data FOLLOWS the move (copied host-to-host, relayed
      // through the control plane — no S3). Ordering is safety-critical:
      //   1. stop the NEW stack — nothing may write its volume while we untar into it;
      //   2. stop the OLD stack — a consistent read (its files can't change mid-tar);
      //   3. copy old → new (wipe-first, overwriting the fresh-init empty volume);
      //   4. start the NEW stack on the migrated data;
      //   5. ONLY THEN destroy the OLD stack + its volume.
      // If the copy fails, the old stack still has all the data — so ROLL BACK: tear
      // down the half-built new stack and restart the old one, then surface the error
      // (the move is undone, the DB stays where it was).
      await stopStackOn(targetServer.id, cur.host);
      await stopStackOn(movingFrom, cur.host);
      try {
        // A database is a single compose volume with no files dir — copy just it.
        await migrateWorkloadData(movingFrom, targetServer.id, {
          volumeNames: [dbVolumeHostName(cur.host)],
        });
      } catch (copyErr) {
        // Roll back: remove the new (empty/partial) stack + volume, bring the old DB
        // back up so the operator is left exactly where they started. Rollback steps
        // are best-effort — a rollback failure is appended, but the ORIGINAL copy
        // error is what we throw (it's the actionable cause).
        await destroyStackOn(targetServer.id, cur.host).catch(() => {});
        await startStackOn(movingFrom, cur.host).catch(() => {});
        throw new Error(
          `Failed to copy ${cur.name}'s data to ${targetServer.name}: ` +
            `${copyErr instanceof Error ? copyErr.message : String(copyErr)}. ` +
            `The move was rolled back — the database is still on its original server.`,
        );
      }
      // Copy succeeded — start the new stack on the migrated data.
      await startStackOn(targetServer.id, cur.host);

      // Tear down the OLD host's stack + its (now-migrated) data volume so it isn't
      // left running and orphaned. Best-effort, exactly like deleteDatabase: the data
      // is already safe on the new host, so a failed/unreachable teardown is surfaced
      // (and logged) rather than rolled back.
      try {
        const old = await connectAgent(movingFrom);
        try {
          const r = await old.destroyStack(cur.host, true);
          if (!r.ok)
            moveWarning =
              `Moved ${cur.name} to ${targetServer.name}, but the old server did ` +
              `not cleanly tear down ${cur.host} (${r.error || "unknown error"}). ` +
              `Its old container/volume may need a manual sweep on that host.`;
        } finally {
          old.close();
        }
      } catch (e) {
        moveWarning =
          `Moved ${cur.name} to ${targetServer.name}, but the old server was ` +
          `unreachable to tear down ${cur.host} ` +
          `(${e instanceof Error ? e.message : String(e)}). Its old container/` +
          `volume may need a manual sweep on that host.`;
      }
    }

    // Persist the new location + exposure + re-derived connection string. On a move
    // the data followed, so `sizeMb` is left as-is (a metrics sweep refreshes it).
    // `host`/`port`/`username`/`dbName` are untouched (the container's DNS identity
    // and credentials are fixed at first init).
    await getDb()
      .update(databasesTable)
      .set({
        serverId: targetServer.id,
        exposedPublicly: exposed,
        exposedPort: newExposedPort,
        connectionStringEnc: connEnc,
      })
      .where(eq(databasesTable.id, id));
  });
  if (moveWarning) console.warn(`[databases] ${moveWarning}`);
  await recordActivity(
    "database",
    movingFrom
      ? moveWarning
        ? `Moved database ${db.name} to ${targetServer.name} (warning: ${moveWarning})`
        : `Moved database ${db.name} to ${targetServer.name}`
      : exposed
        ? `Exposed database ${db.name} on port ${newExposedPort}`
        : `Unexposed database ${db.name}`,
    user.name,
    null,
  );
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

/* ------------------------------------------------------------------ */
/* Focused post-create mutations (the database detail page)            */
/* ------------------------------------------------------------------ */

/**
 * Save a database's per-container resource limits (Settings → Resources).
 * A row write only — no agent call, no lock: the limits are baked into the
 * rendered compose (renderDatabaseStackYaml), so they take effect on the NEXT
 * redeploy or settings-driven reroute, exactly like app resource limits take
 * effect on the next deploy. Validation is the shared `cleanResourceLimits`
 * (same bounds, same cross-field checks as apps).
 */
export async function updateDatabaseResources(
  id: string,
  input: ResourceLimitsInput,
): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;
  const cleaned = cleanResourceLimits(input);
  const updated = await getDb()
    .update(databasesTable)
    .set(resourceLimitsToRow(cleaned))
    .where(
      and(eq(databasesTable.id, id), eq(databasesTable.teamId, membership.teamId)),
    )
    .returning({ id: databasesTable.id });
  if (updated.length === 0) throw new Error("Not found");
  await recordActivity("database", "Updated database resource limits", user.name, null);
}

/** A docker image reference the compose can carry as a plain scalar: repo /
 *  registry path, optional tag/digest. Anything else (whitespace, quotes, YAML
 *  metacharacters) is rejected rather than escaped — an image ref never
 *  legitimately contains them. */
function isValidImageRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(ref);
}

/**
 * Save a database's expert overrides (Settings → Advanced): a custom image
 * replacing the derived engine image, a custom command replacing the default
 * verbatim, and/or a version (image tag) change. A row write only — applied on
 * the next redeploy/reroute ("the row is truth"). No engine-compat validation
 * beyond syntax: this IS the expert escape hatch — the UI carries the warnings
 * (redis `--requirepass`, cross-version data compatibility).
 */
export async function updateDatabaseImage(
  id: string,
  input: {
    /** Full image ref, or null to clear back to the derived engine image. */
    customImage?: string | null;
    /** Verbatim command override, or null to clear back to the image default. */
    customCommand?: string | null;
    /** New engine version (image tag). Inert while customImage is set. */
    version?: string;
  },
): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;

  const patch: Partial<typeof databasesTable.$inferInsert> = {};
  if (input.customImage !== undefined) {
    const img = input.customImage?.trim() || null;
    if (img && !isValidImageRef(img))
      throw new Error(
        "Custom image must be a plain image reference (repo[:tag] or repo@digest) with no spaces or quotes.",
      );
    patch.customImage = img;
  }
  if (input.customCommand !== undefined) {
    const cmd = input.customCommand?.trim() || null;
    // One line, no control chars: the value is emitted into the compose as a
    // quoted scalar, but a multi-line "command" is never what the user meant.
    if (cmd && /[\r\n\t]/.test(cmd))
      throw new Error("Custom command must be a single line.");
    patch.customCommand = cmd;
  }
  if (input.version !== undefined) {
    const v = input.version.trim();
    if (!v || !/^[A-Za-z0-9._-]+$/.test(v))
      throw new Error("Version must be a valid image tag.");
    patch.version = v;
  }
  if (Object.keys(patch).length === 0) return;

  const updated = await getDb()
    .update(databasesTable)
    .set(patch)
    .where(
      and(eq(databasesTable.id, id), eq(databasesTable.teamId, membership.teamId)),
    )
    .returning({ id: databasesTable.id });
  if (updated.length === 0) throw new Error("Not found");
  await recordActivity("database", "Updated database image settings", user.name, null);
}

/**
 * Restart the database container (stop + start on the owning agent). Unlike
 * redeploy this does NOT re-render the compose — it bounces the container
 * exactly as configured on the host. Same lock/gate discipline as
 * setDatabaseRunning.
 */
export async function restartDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning — wait for it to finish before restarting it.",
      );
    const conn = await connectAgent(cur.serverId);
    try {
      const stop = await conn.stopStack(cur.host);
      if (!stop.ok) throw new Error(stop.error || "agent failed to stop the database");
      const start = await conn.startStack(cur.host);
      if (!start.ok)
        throw new Error(start.error || "agent failed to start the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
  });
  await recordActivity("database", "Restarted database", user.name, null);
}

/**
 * Re-render the database's compose from the CURRENT row and reroute it on its
 * owning server — the "apply my pending settings" verb. This is what makes
 * resource limits / image / command edits take effect, and it is also the
 * migration path that stamps the deplo.* labels onto containers provisioned
 * before the labels existed (enabling logs / terminal / the runtime poll).
 * `docker compose up -d` recreates the container only when its config actually
 * changed; the data volume is always preserved.
 */
export async function redeployDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning — wait for it to finish before redeploying it.",
      );
    const password = parseConnectionPassword(decryptSecret(cur.connectionStringEnc));
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: [],
      });
      if (!res.ok)
        throw new Error(res.error || "agent failed to redeploy the database");
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
  });
  await recordActivity("database", "Redeployed database", user.name, null);
}

/**
 * The per-engine in-engine rotation step. postgres / mysql / mariadb / mongodb
 * persist their users INSIDE the data volume, so changing the compose env alone
 * is a silent no-op on an initialized volume — the engine must be told first,
 * via an exec in the running container. redis (command-carried `--requirepass`)
 * and clickhouse (config regenerated from env on every container start, outside
 * the data volume) rotate through the compose re-render alone.
 *
 * mysql/mariadb rotate BOTH root and the scoped user: root's password == the
 * connection-string password is load-bearing for backups (`dumpUserFor` dumps
 * as root with that password). `IF EXISTS` keeps the statement idempotent
 * across the images' root@'%'/root@localhost variants.
 */
function rotationExecCommand(
  db: Database,
  oldPassword: string,
  newPassword: string,
): string | null {
  switch (db.type) {
    case "postgres":
      // Unix-socket auth inside the official image is `trust` — no old password
      // needed; the POSTGRES_USER login is a superuser.
      return `psql -U ${db.username} -d ${db.dbName} -c "ALTER USER \\"${db.username}\\" WITH PASSWORD '${newPassword}'"`;
    case "mysql":
    case "mariadb": {
      const stmts = [
        `ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY '${newPassword}';`,
        `ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY '${newPassword}';`,
        ...(db.username !== "root"
          ? [`ALTER USER IF EXISTS '${db.username}'@'%' IDENTIFIED BY '${newPassword}';`]
          : []),
        "FLUSH PRIVILEGES;",
      ].join(" ");
      return `mysql -uroot -p'${oldPassword}' -e "${stmts}"`;
    }
    case "mongodb":
      return (
        `mongosh -u ${db.username} -p '${oldPassword}' --authenticationDatabase admin --quiet ` +
        `--eval "db.getSiblingDB('admin').changeUserPassword('${db.username}', '${newPassword}')"`
      );
    case "redis":
    case "clickhouse":
      return null; // compose re-render alone rotates
  }
}

/**
 * Rotate a database's engine password. Two-phase, old-credentials-safe:
 *
 *  1. Engines with volume-persisted users are told FIRST via an exec in the
 *     running container ({@link rotationExecCommand}) — if that fails, nothing
 *     was written and the old password stays fully valid.
 *  2. The row's connection string is re-encrypted around the new password and
 *     the stack is rerouted so the compose env / command / healthcheck agree
 *     with the engine again. If the reroute fails AFTER a successful in-engine
 *     rotation, the row already matches reality — "Redeploy" reconciles the
 *     container config (the error says so).
 *
 * Requires the database to be RUNNING (the exec needs a live engine, and
 * rotating a stopped redis would silently start it). Returns the NEW connection
 * string — shown once by the UI, same contract as revealConnection.
 */
export async function rotateDatabasePassword(
  id: string,
  input: { password?: string } = {},
): Promise<string> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  const user = (await getCurrentUser())!;

  const newPassword = input.password?.trim() || randomToken(24);
  assertPasswordSafe(newPassword);
  // Rotation embeds the password in an exec'd shell command (quoted with ' and
  // "), which create never does — reject quotes on top of the create rules.
  if (/['"]/.test(newPassword))
    throw new Error("Password may not contain quotes");

  let newConn = "";
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status !== "running")
      throw new Error("Start the database before rotating its password.");

    const oldPassword = parseConnectionPassword(decryptSecret(cur.connectionStringEnc));
    // Old quotes would break the exec quoting below the same way; created
    // passwords can legitimately contain them (create never rejected quotes).
    const execCmd = rotationExecCommand(cur, oldPassword, newPassword);
    if (execCmd && /['"]/.test(oldPassword))
      throw new Error(
        "This database's current password contains quotes, which the in-engine rotation step can't carry safely.",
      );

    // Phase 1 — tell the engine (postgres/mysql/mariadb/mongodb). Abort on any
    // failure: nothing has been written yet, the old password stays valid. Never
    // echo the command (it carries both passwords) — surface only the engine's
    // own stderr.
    if (execCmd) {
      const conn = await connectAgent(cur.serverId);
      try {
        const res = await conn.exec(
          cur.id,
          cur.host,
          execCmd,
          effectiveDatabaseImage(cur),
        );
        if (isDockerLevelStderr(res.stderr))
          throw new Error(
            `Could not run the rotation inside the container: ${res.stderr.trim()}`,
          );
        if (res.code !== 0)
          throw new Error(
            `The engine rejected the password change${res.stderr.trim() ? `: ${res.stderr.trim()}` : ` (exit ${res.code})`}`,
          );
      } finally {
        conn.close();
      }
    }

    // Phase 2 — re-derive the connection string around the UNCHANGED host/port
    // and persist it, then reroute so the compose (env / redis command /
    // healthcheck) agrees with the engine again.
    const exposedHostPort =
      cur.exposedPublicly && cur.exposedPort != null ? cur.exposedPort : null;
    const server =
      exposedHostPort != null ? await resolveTeamServer(teamId, cur.serverId) : null;
    newConn = buildConnectionString({
      type: cur.type,
      username: cur.username,
      password: newPassword,
      host: server ? server.host : cur.host,
      port: exposedHostPort ?? cur.port,
      dbName: cur.dbName,
    });
    await getDb()
      .update(databasesTable)
      .set({ connectionStringEnc: encryptSecret(newConn) })
      .where(eq(databasesTable.id, id));

    const updated: Database = { ...cur, connectionStringEnc: encryptSecret(newConn) };
    const yaml = renderDatabaseStackYaml(updated, newPassword);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: [],
      });
      if (!res.ok)
        throw new Error(
          `The password was rotated but the container config could not be updated ` +
            `(${res.error || "agent error"}). Run Redeploy to bring it in sync.`,
        );
    } finally {
      conn.close();
    }
  });
  await recordActivity("database", "Rotated database password", user.name, null);
  return newConn;
}
