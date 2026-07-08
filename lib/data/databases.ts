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
import {
  connectAgent,
  mapCheckPortUnsupported,
  mapVolumeCopyUnsupported,
} from "../infra/agent-client";
import {
  generateDatabaseCompose,
  buildConnectionString,
  parseConnectionPassword,
} from "../deploy/database-compose";
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
  // Service name == container DNS name on the shared `deplo` network == the
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
    username,
    password,
    dbName,
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
    username: string;
    password: string;
    dbName: string;
    /** The validated host port to publish, or undefined for an unexposed DB. */
    hostPort?: number;
  },
): Promise<void> {
  const yaml = generateDatabaseCompose({
    name: opts.service,
    type: opts.type,
    version: opts.version,
    username: opts.username,
    password: opts.password,
    dbName: opts.dbName,
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

/**
 * The host-side Docker volume name of a database's data volume. The DB compose
 * declares the volume as `<slug>-data` with NO `name:` override (see
 * generateDatabaseCompose), so Docker Compose prefixes it with the project name
 * (`-p deplo-<slug>`) → `deplo-<slug>_<slug>-data`. This is the exact string the
 * agent's ExportVolume/ImportVolume operate on. Matches the compose-stack
 * convention `composeStackVolumeHostNames` uses for projects (`deplo-<slug>_<key>`).
 */
function dbVolumeHostName(slug: string): string {
  return `deplo-${slug}_${slug}-data`;
}

/**
 * Copy a database's data volume from its OLD server to its NEW one, for a move.
 * Docker named volumes are host-local and the agent trust model is strictly star
 * (an agent can neither dial nor trust a peer), so the bytes RELAY through the
 * control plane: the source agent streams the volume's gzipped tar out
 * (`exportVolume`), and those chunks are fed straight into the destination agent's
 * `importVolume` (wipe-first, so it overwrites the empty volume the freshly-
 * provisioned stack created). No S3 hop, no agent↔agent link. BOTH stacks must be
 * STOPPED before this runs — the destination so nothing writes the volume under the
 * untar, the source so its on-disk files can't change mid-read (a consistent copy).
 * A too-old agent on either side surfaces AgentVolumeCopyUnsupportedError ("update
 * the agent"). Throws on any failure so the caller can roll the move back.
 */
async function copyDatabaseVolume(
  fromServerId: string,
  toServerId: string,
  slug: string,
): Promise<void> {
  const volume = dbVolumeHostName(slug);
  const source = await connectAgent(fromServerId);
  try {
    const dest = await connectAgent(toServerId);
    try {
      // Drive the destination import with the source export as its chunk source —
      // one async pipe, no full-volume buffering in the control plane. Any
      // UNIMPLEMENTED (agent too old) is mapped to a clear "update the agent" error,
      // attributed to the side that rejected.
      let res: { ok: boolean; error: string };
      try {
        res = await dest.importVolume(volume, true, source.exportVolume(volume));
      } catch (e) {
        // The export (source) or import (dest) rejected. Attribute UNIMPLEMENTED to
        // whichever side is too old — try mapping as source first, then dest; a
        // non-UNIMPLEMENTED error passes through unchanged either way.
        const mapped = mapVolumeCopyUnsupported(e, "source");
        throw mapped instanceof Error &&
          mapped.constructor.name === "AgentVolumeCopyUnsupportedError"
          ? mapped
          : mapVolumeCopyUnsupported(e, "destination");
      }
      if (!res.ok)
        throw new Error(res.error || "agent failed to import the data volume");
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
}

/**
 * Edit a database's post-create-mutable settings: its public exposure
 * (publish/unpublish + host port) and, optionally, the SERVER it runs on.
 * Everything else (engine, version, username, db name, password) is create-only —
 * the official images apply those env vars only on first init against an empty
 * volume, so changing them would be a silent no-op or data loss.
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
  const yaml = generateDatabaseCompose({
    name: db.host, // service slug, stable
    type: db.type,
    version: db.version,
    username: db.username,
    password,
    dbName: db.dbName,
    hostPort: newExposedPort ?? undefined,
  });

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
    // Provision on the TARGET server first. On a move this creates the stack fresh
    // on the new host (empty volume); in place it reroutes the existing container.
    // Doing this BEFORE any old-host teardown means a failed reroute leaves the
    // original stack untouched — the move is atomic from the operator's view.
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

    // A move succeeded on the new host — now tear down the OLD host's stack + its
    // (now-stale) data volume so it isn't left running and orphaned. Best-effort,
    // exactly like deleteDatabase: the move is already done, so a failed/unreachable
    // teardown is surfaced (and logged) rather than rolled back. `removeVolumes`
    // reclaims the old volume; a too-old agent that ignores it leaves the volume to
    // sweep by hand.
    if (movingFrom) {
      try {
        const old = await connectAgent(movingFrom);
        try {
          const r = await old.destroyStack(cur.host, true);
          if (!r.ok)
            moveWarning =
              `Moved ${cur.name}, but the old server did not cleanly tear down ` +
              `${cur.host} (${r.error || "unknown error"}). Its old container/` +
              `volume may need a manual sweep on that host.`;
        } finally {
          old.close();
        }
      } catch (e) {
        moveWarning =
          `Moved ${cur.name}, but the old server was unreachable to tear down ` +
          `${cur.host} (${e instanceof Error ? e.message : String(e)}). Its old ` +
          `container/volume may need a manual sweep on that host.`;
      }
    }

    // Persist the new location + exposure + re-derived connection string. On a move
    // the container comes up fresh, so reset the tracked size to 0 (the old volume's
    // bytes didn't follow). `host`/`port`/`username`/`dbName` are untouched (the
    // container's DNS identity and credentials are fixed at first init).
    await getDb()
      .update(databasesTable)
      .set({
        serverId: targetServer.id,
        exposedPublicly: exposed,
        exposedPort: newExposedPort,
        connectionStringEnc: connEnc,
        ...(movingFrom ? { sizeMb: 0 } : {}),
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
