import "server-only";

// https://deplo.build/docs/guides/data/databases

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import {
  listServersForTeam,
  assertServerAccessibleTx,
  getServerById,
  canHostWorkloads,
} from "./servers";
import { getDb } from "../db/client";
import { narrowedScope } from "../auth/request-context";
import {
  databaseMounts as databaseMountsTable,
  databases as databasesTable,
  teamDatabaseOrder,
} from "../db/schema/control-plane";
import { assembleDatabase, databaseToRow } from "./backup-rows";
import { cleanResourceLimits, type ResourceLimitsInput } from "./apps";
import { resourceLimitsToRow } from "./app-graph-rows";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
  requireMountHostVolumes,
  canExposePorts,
  requireTeamWide,
} from "../membership";
import { recordActivity } from "./activity";
import { matchesQuery } from "./match-query";
import { dispatchAlert } from "../notify/dispatch";
import {
  encryptSecret,
  decryptSecret,
  decryptSecretOrThrow,
  randomToken,
} from "../crypto";
import { connectAgent, mapCheckPortUnsupported } from "../infra/agent-client";
import {
  migrateWorkloadData,
  stopStackOn,
  startStackOn,
  destroyStackOn,
} from "./volume-migration";
import {
  DB_DATA_DIRS,
  generateDatabaseCompose,
  buildConnectionString,
  parseConnectionPassword,
  effectiveDatabaseImage,
} from "../deploy/database-compose";
import { isDockerLevelStderr } from "../infra/docker";
import { stackFilesDir } from "../deploy/deploy-key";
import { isValidLogoValue } from "../apps/logo-shared";
import { MIN_USER_PORT, MAX_PORT, isValidExposePort } from "../databases/ports";
import { withKeyedLock } from "./keyed-mutex";
import { enqueueTeardowns } from "./teardown-queue";
import { assertDataCopyIntact, clearDataCopyError } from "./data-copy";
import { assertNotMigrating } from "./migration-guard";
import { assertPasswordNotPwned } from "../pwned-password";
import { assertPasswordPolicy } from "../password-policy";
import { publishDatabaseChanged } from "../graphql/pubsub";
import type { Database, DatabaseMount, DatabaseType } from "../types";

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
// database is exposed publicly.
const EXPOSE_PORT_MIN = 20000;
const EXPOSE_PORT_MAX = 40000;

/** The engine login used when the caller doesn't supply a custom username -
 *  matches the historical per-engine hardcode (redis 'default', else 'app'). */
function defaultUserFor(type: DatabaseType): string {
  return type === "redis" ? "default" : "app";
}

/** Cap the display name like every other named resource (App, Project, Folder,
 *  Environment) so a multi-MB name can't bloat every RSC payload / activity row. */
const DB_NAME_MAX = 60;

/**
 * Clean a user-supplied DISPLAY name.
 */
function cleanDatabaseName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Database name is required.");
  if (trimmed.length > DB_NAME_MAX)
    throw new Error(
      `Database name must be ${DB_NAME_MAX} characters or fewer.`,
    );
  return trimmed;
}

/**
 * Derive the host-side slug from a display name: the compose project
 * (`db-<slug>`), its container_name, its data volume and its DNS name on the
 * `deplo` network all hang off it.
 */
function databaseSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!/[a-z0-9]/.test(slug))
    throw new Error("Name must contain at least one letter or number.");
  return slug;
}

/** Friendly message for the `databases_team_name_uq` violation a concurrent
 *  create/rename can still lose to after our own pre-check passed. */
function isDuplicateNameError(e: unknown): boolean {
  return String((e as { message?: string })?.message ?? e).includes(
    "databases_team_name_uq",
  );
}

/**
 * Sanitize a user-supplied engine identifier (DB user or DB name) to a portable,
 * URL-safe SQL identifier: lowercased, `[a-z0-9_]`, starting with a letter or
 * underscore.
 */
function sanitizeDbIdentifier(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
  if (!cleaned || /^[0-9]/.test(cleaned)) return null;
  return cleaned.slice(0, 63); // postgres identifier limit; also under mysql's 64
}

/**
 * Reject a password that would corrupt the two places it is written: `$` is
 * interpolated out by docker-compose on the `- KEY=value` line this rides, and
 * whitespace or a control char breaks both the line and the YAML.
 */
function assertPasswordSafe(password: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[$\s\u0000-\u001f\u007f]/.test(password))
    throw new Error("Password may not contain $ or whitespace");
}

/**
 * Resolve the server a team may provision/reroute a database on: it must exist, be
 * visible to the team (an `all_teams` server or one granted to it), and be
 * provisioned (have a live agent). Throws a caller-facing error otherwise.
 */
async function resolveTeamServer(teamId: string, serverId?: string) {
  // A specialised host runs no workload: storage-only has no Docker at all, and
  // build-only compiles for other machines and has no proxy.
  const servers = (await listServersForTeam(teamId)).filter(canHostWorkloads);
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
 * Ask the owning server's agent whether a host TCP port is free to publish.
 */
async function isHostPortFree(
  serverId: string,
  port: number,
): Promise<boolean> {
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
 * Whether another database ALREADY holds this host port on this server, by row.
 * Servers are shared, and a host port is a singleton on the machine, so the answer
 * cannot depend on who is asking.
 */
async function portClaimedByAnotherDatabase(
  serverId: string,
  port: number,
  exceptId?: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.serverId, serverId),
        eq(databasesTable.exposedPublicly, true),
        eq(databasesTable.exposedPort, port),
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

/**
 * The one check a host port has to pass before it is written: nothing is listening
 * on it right now, AND no other database row has already reserved it.
 */
async function assertHostPortAvailable(
  server: { id: string; name: string },
  port: number,
  exceptId?: string,
): Promise<void> {
  if (
    (await portClaimedByAnotherDatabase(server.id, port, exceptId)) ||
    !(await isHostPortFree(server.id, port))
  )
    throw new Error(
      `Port ${port} is already in use on ${server.name}. Pick a different port.`,
    );
}

/**
 * Which of these host ports are taken on this server, for a screen that wants to
 * say so BEFORE anything is created - the import review, where a database carries
 * the port it had on the other platform and the person still has a choice about
 * it.
 */
export async function hostPortsInUse(
  serverId: string,
  ports: number[],
): Promise<{ checked: boolean; inUse: number[]; reason: string | null }> {
  const teamId = await requireActiveTeamId();
  if (!(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");
  const server = await resolveTeamServer(teamId, serverId);

  // One RPC per port, so the list is deduped and bounded. 50 is far above any
  // real import (a source publishes a port on a handful of databases, not fifty)
  // and well under anything that would hold the review open.
  //
  // ANY real TCP port, not only the ones a user may ask for: 80 and 443 belong to
  // the proxy, so an imported reverse proxy is exactly what this has to catch, and
  // `isValidExposePort` (which gates what may be WRITTEN) filtered both out.
  const wanted = [...new Set(ports)]
    .filter((p) => Number.isInteger(p) && p >= 1 && p <= MAX_PORT)
    .slice(0, 50);
  const inUse: number[] = [];
  for (const port of wanted) {
    if (await portClaimedByAnotherDatabase(server.id, port)) {
      inUse.push(port);
      continue;
    }
    try {
      if (!(await isHostPortFree(server.id, port))) inUse.push(port);
    } catch (e) {
      return {
        checked: false,
        inUse: [],
        reason:
          e instanceof Error
            ? e.message
            : "Deplo could not check ports on this server.",
      };
    }
  }
  return { checked: true, inUse, reason: null };
}

/**
 * Pick a host port that is currently free on the given server, drawn from the high
 * ephemeral range. The port is only a SUGGESTION - creation re-checks it, so a
 * race between suggest and submit is caught there too.
 */
export async function generateAvailableDbPort(input: {
  serverId?: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");
  const server = await resolveTeamServer(teamId, input.serverId);

  // Start at a random offset in the range so repeated clicks (and concurrent callers)
  // don't all probe the same candidate first, then step by a fixed stride to spread
  // the search across the range.
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

/**
 * The config files of one or more databases, keyed by id and in stored order.
 */
async function mountsByDatabase(
  ids: string[],
): Promise<Map<string, DatabaseMount[]>> {
  const out = new Map<string, DatabaseMount[]>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(databaseMountsTable)
    .where(inArray(databaseMountsTable.databaseId, ids))
    .orderBy(databaseMountsTable.databaseId, databaseMountsTable.position);
  for (const r of rows) {
    const list = out.get(r.databaseId) ?? [];
    list.push({
      filePath: r.filePath,
      content: r.content,
      mountPath: r.mountPath,
    });
    out.set(r.databaseId, list);
  }
  return out;
}

/** The one database's config files, in stored order. */
async function mountsFor(id: string): Promise<DatabaseMount[]> {
  return (await mountsByDatabase([id])).get(id) ?? [];
}

function toDTO(db: Database): DatabaseDTO {
  const { connectionStringEnc, ...rest } = db;
  return {
    ...rest,
    connectionStringMasked: maskConnectionString(
      decryptSecret(connectionStringEnc),
    ),
  };
}

/**
 * Load one team-scoped database row, assembled, or null.
 */
export async function loadDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<Database | null> {
  return loadDatabase(id, teamId, { forRead: true });
}

/** Cookie-free team-scoped DTO load - the `databaseStatus` subscription
 *  generator's only data edge (masked, no `connectionStringEnc`). */
export async function getDatabaseForTeam(
  id: string,
  teamId: string,
): Promise<DatabaseDTO | null> {
  // The SESSION-FREE twin, so it does NOT consult the ambient request identity - its
  // only caller is the status stream, whose ticks run after the HTTP handler returned
  // the streaming Response, with no cookies left to read.
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) return null;
  return toDTO(assembleDatabase(rows[0], await mountsFor(rows[0].id)));
}

/**
 * Load one team-scoped database row, assembled, or null. It reads as NOT FOUND
 * rather than as a scope error, so a scope can never become an oracle for which
 * database ids exist.
 */
/**
 * A database row for the active team, and - by default - a REFUSAL while a
 * migration is still creating it. The three READ callers say so explicitly,
 * because watching a service arrive is exactly what somebody should be able to do.
 */
async function loadDatabase(
  id: string,
  teamId: string,
  opts: { forRead?: boolean } = {},
): Promise<Database | null> {
  // A database belongs to the team and to no project, so a principal who reaches only
  // part of the team reaches none of them - a token narrowed to a project, and
  // equally a member on a limited role.
  if (narrowedScope()) return null;
  if (!(await reachesWholeTeam())) return null;
  const rows = await getDb()
    .select()
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) return null;
  if (!opts.forRead)
    assertNotMigrating("database", rows[0].name, rows[0].migrationRunId);
  return assembleDatabase(rows[0], await mountsFor(rows[0].id));
}

/** Team-wide manual database order (the `team_database_order` junction), id→rank. */
async function databaseOrderRank(teamId: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({
      databaseId: teamDatabaseOrder.databaseId,
      position: teamDatabaseOrder.position,
    })
    .from(teamDatabaseOrder)
    .where(eq(teamDatabaseOrder.teamId, teamId));
  return new Map(rows.map((r) => [r.databaseId, r.position] as const));
}

/**
 * Every database in the active team. `query` filters by name or id, with the
 * same match `listApps` and `search` use, so the three never disagree about what
 * counts as a hit.
 */
export async function listDatabases(query?: string): Promise<DatabaseDTO[]> {
  await requireTeamWide("databases");
  const teamId = await requireActiveTeamId();
  const [rows, rank] = await Promise.all([
    getDb()
      .select()
      .from(databasesTable)
      .where(eq(databasesTable.teamId, teamId)),
    databaseOrderRank(teamId),
  ]);
  // Honour the team's manual order (Storage grid drag-and-drop) when present:
  // explicitly-ordered databases come first in that order, anything not listed (a
  // brand-new database, or before any reorder) falls back to newest-first - the same
  // rule the Overview apps grid uses.
  const mounts = await mountsByDatabase(rows.map((r) => r.id));
  return rows
    .map((r) => toDTO(assembleDatabase(r, mounts.get(r.id) ?? [])))
    .filter((d) => !query || matchesQuery(query, d.name, d.id))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Infinity;
      const rb = rank.get(b.id) ?? Infinity;
      if (ra !== rb) return ra - rb;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

/**
 * Persist the team-wide order of databases in the Storage grid. A dead id can't be
 * stored (the FK CASCADE makes the self-healing a DB invariant).
 */
export async function reorderDatabases(orderedIds: string[]): Promise<void> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  await getDb().transaction(async (tx) => {
    // Newest-first, so a database the client omitted appends in a sensible,
    // deterministic order after the explicitly-ordered ones.
    const teamDbIds = (
      await tx
        .select({ id: databasesTable.id })
        .from(databasesTable)
        .where(eq(databasesTable.teamId, teamId))
        .orderBy(desc(databasesTable.createdAt))
    ).map((r) => r.id);
    const valid = new Set(teamDbIds);
    const seen = new Set<string>();
    const next: string[] = [];
    for (const id of orderedIds) {
      if (valid.has(id) && !seen.has(id)) {
        seen.add(id);
        next.push(id);
      }
    }
    for (const id of teamDbIds) if (!seen.has(id)) next.push(id);
    await tx
      .delete(teamDatabaseOrder)
      .where(eq(teamDatabaseOrder.teamId, teamId));
    if (next.length > 0) {
      await tx.insert(teamDatabaseOrder).values(
        next.map((databaseId, position) => ({
          teamId,
          databaseId,
          position,
        })),
      );
    }
  });
}

export async function getDatabase(id: string): Promise<DatabaseDTO | null> {
  const teamId = await requireActiveTeamId();
  const db = await loadDatabase(id, teamId, { forRead: true });
  return db ? toDTO(db) : null;
}

export async function getConnectionString(id: string): Promise<string> {
  // This returns the plaintext connection string (embeds the DB password), so it must
  // enforce the capability at the data-layer boundary itself, not lean on the
  // revealConnection field's authScope alone (keep BOTH gates).
  const { teamId } = await requireCapability("reveal_secrets");
  // A read: the credentials of a database still arriving are the same
  // credentials it will have, and somebody watching it land may want them.
  const db = await loadDatabase(id, teamId, { forRead: true });
  if (!db) throw new Error("Not found");
  return decryptSecret(db.connectionStringEnc);
}

export async function createDatabase(input: {
  name: string;
  type: DatabaseType;
  version: string;
  serverId?: string;
  /**
   * The engine login to create. Forced to `default` for redis (there is no
   * mechanism to create a redis ACL user, so any override would emit an unusable
   * connection string).
   */
  username?: string;
  /**
   * The logical database to create. Optional - falls back to the service name
   * (`db-<name>`), which is what databases created before this input always used,
   * so backups keep dumping the identical database. Sanitized like {@link username}.
   */
  dbName?: string;
  /**
   * The engine password. Optional - falls back to an auto-generated URL-safe
   * token. A supplied password is validated for URL/env-file safety. Stored only
   * inside the encrypted connection string (never a column, never returned).
   */
  password?: string;
  /**
   * The supplied password was GENERATED by a machine rather than typed by a person -
   * today that is an import carrying another platform's credential.
   */
  passwordIsGenerated?: boolean;
  exposedPublicly?: boolean;
  /**
   * The host port to publish on when {@link exposedPublicly} is true.
   */
  exposedPort?: number;
  /**
   * Run this exact image instead of the one derived from type + version.
   */
  customImage?: string | null;
}): Promise<DatabaseDTO> {
  const { membership } = await requireCapability("create_databases");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  // Display name as typed (trimmed) vs. the slug the host artifacts are named after:
  // "My Main DB" now STAYS "My Main DB" on the card and runs as the stack
  // `db-my-main-db`, instead of the name itself being slugified into "my-main-db" for
  // everyone to read forever.
  const name = cleanDatabaseName(input.name);
  const slug = databaseSlug(name);
  // The version is interpolated raw into the compose `image:` scalar
  // (`postgres:${version}-alpine`), so validate it as an image tag up front - the
  // update path (updateDatabaseImage) already does; the create path had the gap.
  if (!/^[A-Za-z0-9._-]+$/.test(input.version))
    throw new Error("Version must be a valid image tag.");
  const customImage = input.customImage?.trim() || null;
  if (customImage && !isValidImageRef(customImage))
    throw new Error(
      "Custom image must be a plain image reference (repo[:tag] or repo@digest) with no spaces or quotes.",
    );
  // Validate a supplied password up front - it is cheap, local input validation,
  // so fail fast (before any server lookup or agent probe) with a clear message
  // rather than surfacing it only after slower checks.
  if (input.password) {
    assertPasswordSafe(input.password);
    if (!input.passwordIsGenerated) {
      assertPasswordPolicy(input.password);
      await assertPasswordNotPwned(input.password);
    }
  }

  const exposed = input.exposedPublicly ?? false;
  // Publishing a host port is a privileged action, separate from manage_infra:
  // gate it on the same canExposePorts grant that gates a project's compose
  // `ports:`. Fail BEFORE any work so an unpermitted caller can't create the DB.
  if (exposed && !(await canExposePorts()))
    throw new Error("You don't have permission to publish ports");

  // Server selection (Step 0): the caller picks the host; default to the sole server
  // when there is exactly one.
  const server = await resolveTeamServer(teamId, input.serverId);

  // The display name is unique per team (`databases_team_name_uq`). Check it here
  // so a duplicate reads as a sentence instead of a raw unique-violation from the
  // INSERT far below - the same courtesy renameDatabase does.
  const nameTaken = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(eq(databasesTable.teamId, teamId), eq(databasesTable.name, name)),
    )
    .limit(1);
  if (nameTaken.length > 0)
    throw new Error(`A database named "${name}" already exists in this team.`);

  // The stack slug `db-<slug>`, its container_name and its data volume are a GLOBAL
  // namespace on the host, but the DB name is only unique per-team, and servers are
  // shared cross-team.
  const slugCollision = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(
        eq(databasesTable.serverId, server.id),
        eq(databasesTable.host, `db-${slug}`),
      ),
    )
    .limit(1);
  if (slugCollision.length > 0)
    throw new Error(
      `A database stack named "db-${slug}" already exists on ${server.name}. Database stacks share a per-host namespace - pick a different name.`,
    );

  // Validate + reserve the host port up front when exposing.
  let exposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error(
        "A host port is required to expose the database publicly",
      );
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid - choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    await assertHostPortAvailable(server, input.exposedPort);
    exposedPort = input.exposedPort;
  }

  const port = DEFAULT_PORTS[input.type];
  // Name slug == container DNS name on the shared `deplo` network == the
  // agent stack slug. Connection strings reference it, so it must stay stable -
  // it is stored in `host` and never re-derived (a rename leaves it alone).
  const service = `db-${slug}`;

  // Resolve the credentials.
  const username =
    input.type === "redis"
      ? "default"
      : ((input.username ? sanitizeDbIdentifier(input.username) : null) ??
        defaultUserFor(input.type));
  const dbName =
    (input.dbName ? sanitizeDbIdentifier(input.dbName) : null) ?? service;
  const password =
    input.password && input.password.length > 0
      ? input.password
      : randomToken(12);

  // The connection host:port depends on reachability.
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
    // Provisioned here, from nothing. Only a migration can hand a database a
    // volume that was supposed to arrive from another host and did not.
    dataCopyError: "",
    migrationRunId: null,
    // No logo of its own: the UI shows the engine's real brand mark until
    // someone uploads one in Settings → General.
    logo: null,
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
    customImage,
    customCommand: null,
    // Off, like an app's: a cron job runs arbitrary commands in the container.
    cronEnabled: false,
    // The engine's defaults are the defaults. A config file is an expert edit
    // made afterwards, never something a new database ships with.
    mounts: [],
    sizeMb: 0,
    createdAt: nowIso(),
  };
  // Re-assert server access inside a tx (SHARE-locks the server row) so a
  // concurrent setServerTeams restrict can't land this database on a server the
  // team just lost access to - pairs with setServerTeams' FOR UPDATE lock.
  await getDb().transaction(async (tx) => {
    await assertServerAccessibleTx(tx, server.id, teamId);
    await tx.insert(databasesTable).values(databaseToRow(db));
  });
  await recordActivity(
    "database",
    `Created database ${name} (${input.type})`,
    user.name,
    null,
    teamId,
  );

  // Provision the real container on the owning server's agent in the background;
  // flips to running/error.
  void provisionDatabase(db, password).catch(async () => {
    // Mark the row errored, but only if it still exists (a concurrent delete may
    // have raced the floated provision; an UPDATE matching no row is a safe no-op).
    await getDb()
      .update(databasesTable)
      .set({ status: "error" })
      .where(eq(databasesTable.id, db.id));
    publishDatabaseChanged(db.id);
    // The request that asked for this database is long gone by now - this catch
    // is floated, so the alert is the only way anybody learns it never came up.
    dispatchAlert({
      teamId,
      key: "database_failed",
      title: `Database ${name} could not be set up`,
      body: "It was created but never finished provisioning on its server.",
      path: "/storage",
    });
  });

  return toDTO(db);
}

/**
 * The ONE render call for a database's compose stack.
 */
/**
 * The config files a Reroute has to carry, in the agent's own shape.
 */
function mountFilesFor(db: Database): { path: string; content: string }[] {
  return db.mounts.map((m) => ({ path: m.filePath, content: m.content }));
}

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
    // The engine's config files.
    mounts: db.mounts,
    filesDir: stackFilesDir(db.host),
  });
}

/**
 * Provision the DB stack on the owning server's agent.
 */
async function provisionDatabase(
  db: Database,
  password: string,
): Promise<void> {
  const yaml = renderDatabaseStackYaml(db, password);
  // Run the provision under the DB's lifecycle lock so a concurrent delete can't
  // interleave: a delete issued during provisioning WAITS here, then tears down a
  // fully-created stack (no orphan).
  await withKeyedLock(db.id, async () => {
    if (!(await databaseExists(db.id))) return; // deleted before us
    const conn = await connectAgent(db.serverId);
    try {
      const res = await conn.reroute({
        slug: db.host,
        composeYaml: yaml,
        env: {},
        mounts: mountFilesFor(db),
      });
      if (!res.ok)
        throw new Error(res.error || "agent failed to provision the database");
    } finally {
      conn.close();
    }
    // A single UPDATE; if the row was deleted while the agent provisioned (under
    // the lock this can't happen, but the UPDATE is a safe no-op regardless).
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, db.id));
    publishDatabaseChanged(db.id);
    dispatchAlert({
      teamId: db.teamId,
      key: "database_ready",
      title: `Database ${db.name} is ready`,
      body: "It finished setting up and is accepting connections.",
      path: "/storage",
    });
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
  running: boolean,
): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const db = await loadDatabase(id, teamId);
  if (!db) throw new Error("Not found");
  const host = db.host;
  const serverId = db.serverId;
  // Serialize on the DB's lifecycle lock: a start/stop issued during provisioning
  // WAITS for the provision to finish rather than racing its status write or hitting
  // a not-yet-created compose project.
  await withKeyedLock(id, async () => {
    // Re-read under the lock - the DB may have been deleted, or just finished
    // provisioning, while we waited our turn.
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    // The compose project doesn't exist until provisioning finishes, so start/stop
    // against a still-provisioning DB would fail on the agent with a confusing "agent
    // failed to…".
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning - wait for it to finish before starting or stopping it.",
      );
    // Lifecycle routes through the owning server's agent. Let a real failure
    // surface to the caller; only update state on success.
    const conn = await connectAgent(serverId);
    try {
      const res = running
        ? await conn.startStack(host)
        : await conn.stopStack(host);
      if (!res.ok)
        throw new Error(
          res.error ||
            `agent failed to ${running ? "start" : "stop"} the database`,
        );
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: running ? "running" : "stopped" })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
  });
}

/**
 * The host-side Docker volume name of a database's data volume.
 */
export function dbVolumeHostName(slug: string): string {
  return `deplo-${slug}_${slug}-data`;
}

/**
 * Edit a database's public exposure (publish/unpublish + host port) and,
 * optionally, the SERVER it runs on.
 */
export async function updateDatabase(
  id: string,
  input: {
    exposedPublicly: boolean;
    exposedPort?: number;
    /**
     * Move the database to this server. Must be a server visible to the team and
     * provisioned (resolved via {@link resolveTeamServer}, same guard as create).
     */
    serverId?: string;
  },
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
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

  // Resolve the TARGET server through the team's visible set: a move can only land on
  // a server this team may use, and an in-place edit re-resolves the current one so a
  // team that LOST access to it can't reroute onto it.
  const targetServer = await resolveTeamServer(
    teamId,
    input.serverId ?? db.serverId,
  );
  // The old host we tear down after a successful move. Non-null only on a move.
  const movingFrom = targetServer.id !== db.serverId ? db.serverId : null;

  // Validate the new exposed port, mirroring create: the bind probe AND the other
  // databases' rows, both against the TARGET server.
  let newExposedPort: number | null = null;
  if (exposed) {
    if (input.exposedPort == null)
      throw new Error(
        "A host port is required to expose the database publicly",
      );
    if (!isValidExposePort(input.exposedPort))
      throw new Error(
        `Port ${input.exposedPort} is invalid - choose an unprivileged port (${MIN_USER_PORT}-${MAX_PORT})`,
      );
    const reusingOwnPort =
      !movingFrom && db.exposedPublicly && db.exposedPort === input.exposedPort;
    if (!reusingOwnPort)
      await assertHostPortAvailable(targetServer, input.exposedPort, db.id);
    newExposedPort = input.exposedPort;
  }

  // No-op short-circuit: nothing changed (same server, same exposure), so skip a
  // pointless reroute (a container recreate) and status churn. A MOVE is never a
  // no-op (the container physically relocates), so it always falls through.
  if (
    !movingFrom &&
    db.exposedPublicly === exposed &&
    db.exposedPort === newExposedPort
  )
    return;

  // The reroute + teardown + row write happen under the DB's lifecycle lock, the SAME
  // lock create/start-stop/delete use: an edit issued during provisioning WAITS, then
  // reroutes a now-running DB; a delete issued during an edit WAITS for the
  // reroute/teardown, then tears down the fully-rerouted stack (no orphan).
  let moveWarning: string | null = null;
  await withKeyedLock(id, async () => {
    // Re-read under the lock - the DB may have been deleted, or just finished
    // provisioning, while we waited our turn.
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    // The compose project doesn't exist until provisioning finishes, so a reroute
    // against a still-provisioning DB would fail confusingly. Gate on the fresh
    // status (same reasoning as setDatabaseRunning).
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning - wait for it to finish before editing it.",
      );
    // Re-derive the connection string around the UNCHANGED create-only password, from
    // the LOCK-FRESH row. Deriving from `cur` here means we always re-encrypt the
    // current password.
    const password = parseConnectionPassword(
      decryptSecretOrThrow(cur.connectionStringEnc, "The database password"),
    );
    const connEnc = encryptSecret(
      buildConnectionString({
        type: cur.type,
        username: cur.username,
        password,
        host: newExposedPort != null ? targetServer.host : cur.host,
        port: newExposedPort != null ? newExposedPort : cur.port,
        dbName: cur.dbName,
      }),
    );
    // Render from the FRESH row (with the new exposure overlaid) so the reroute
    // also applies any pending row edits - resource limits, image/command
    // overrides - saved since the pre-lock read ("the row is truth").
    const yaml = renderDatabaseStackYaml(
      { ...cur, exposedPublicly: exposed, exposedPort: newExposedPort },
      password,
    );
    // Provision on the TARGET server first.
    const agent = await connectAgent(targetServer.id);
    try {
      const res = await agent.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: mountFilesFor(cur),
      });
      if (!res.ok)
        throw new Error(res.error || "agent failed to update the database");
    } finally {
      agent.close();
    }

    if (movingFrom) {
      // MOVE: migrate the data volume from the old host to the new one, then tear down
      // the old. ONLY THEN destroy the OLD stack + its volume.
      await stopStackOn(targetServer.id, cur.host);
      await stopStackOn(movingFrom, cur.host);
      try {
        // A database is a single compose volume with no files dir - copy just it.
        const moved = await migrateWorkloadData(movingFrom, targetServer.id, {
          volumeNames: [dbVolumeHostName(cur.host)],
        });
        // Deplo provisioned this database and started it, so its volume EXISTS.
        // Not finding it means the name is wrong, and carrying on would tear the
        // old host down over a copy that moved nothing.
        if (moved.missing.length > 0)
          throw new Error(
            `${moved.missing.join(", ")} is not on that server, so there was nothing to move`,
          );
      } catch (copyErr) {
        // Roll back: remove the new (empty/partial) stack + volume, bring the old DB back
        // up so the operator is left exactly where they started.
        await destroyStackOn(targetServer.id, cur.host).catch(() => {});
        await startStackOn(movingFrom, cur.host).catch(() => {});
        throw new Error(
          `Failed to copy ${cur.name}'s data to ${targetServer.name}: ` +
            `${copyErr instanceof Error ? copyErr.message : String(copyErr)}. ` +
            `The move was rolled back - the database is still on its original server.`,
        );
      }
      // Copy succeeded - start the new stack on the migrated data.
      try {
        await startStackOn(targetServer.id, cur.host);
      } catch (e) {
        moveWarning =
          `Moved ${cur.name}'s data to ${targetServer.name}, but its stack did not ` +
          `start there (${e instanceof Error ? e.message : String(e)}). ` +
          `Redeploy the database to bring it up.`;
      }

      // Tear down the OLD host's stack + its (now-migrated) data volume so it isn't left
      // running and orphaned.
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

    // Persist the new location + exposure + re-derived connection string.
    // `host`/`port`/`username`/`dbName` are untouched (the container's DNS identity and
    // credentials are fixed at first init).
    await getDb()
      .update(databasesTable)
      .set({
        serverId: targetServer.id,
        exposedPublicly: exposed,
        exposedPort: newExposedPort,
        connectionStringEnc: connEnc,
      })
      .where(eq(databasesTable.id, id));
    publishDatabaseChanged(id);
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

/**
 * Tear a database's stack down on its owning server and PROVE nothing of it
 * survived. That is exactly the "you must know Docker/SSH" hole the product exists
 * to close.
 */
async function teardownDatabaseStack(db: Database): Promise<string | null> {
  const conn = await connectAgent(db.serverId);
  try {
    let res = await conn.destroyStack(db.host, true);
    if (!res.ok) {
      // Rewrite the stack file from the row, then tear down again. The volume is about to
      // be dropped, so the value is irrelevant: fall back to a throwaway rather than
      // throw (which would block reclaiming the volume).
      let password: string;
      try {
        password = parseConnectionPassword(
          decryptSecretOrThrow(db.connectionStringEnc, "The database password"),
        );
      } catch {
        password = randomToken(24);
      }
      const healed = await conn.reroute({
        slug: db.host,
        composeYaml: renderDatabaseStackYaml(db, password),
        env: {},
        mounts: mountFilesFor(db),
      });
      // A failed heal leaves `res`, the ORIGINAL destroy error, as the reason;
      // it is the actionable one (the heal error is a symptom of the same host).
      if (healed.ok) res = await conn.destroyStack(db.host, true);
    }
    // Trust, then verify. An agent too old for the label (or one that errors on
    // the probe) yields null: we can't verify, so the destroy's own verdict
    // stands rather than blocking a delete on a check we couldn't run.
    const left = await conn
      .listInstances(db.id, db.host, db.host)
      .catch(() => null);
    const leftover = left !== null && left.length > 0;
    if (leftover || !res.ok) {
      // Whatever we could not remove must at least not be SERVING - the user asked for
      // this database to go.
      await conn.stopStack(db.host).catch(() => {});
      return leftover
        ? `its container survived the teardown` +
            (res.error ? ` (${res.error})` : "")
        : res.error || "the teardown failed";
    }
    return null;
  } finally {
    conn.close();
  }
}

/**
 * Delete a database: stop + destroy the real container and its data volume on the
 * owning server, then drop the row and everything hanging off it.
 */
export async function deleteDatabase(
  id: string,
  opts: { force?: boolean } = {},
): Promise<void> {
  const { membership } = await requireCapability("delete_databases");
  const user = (await getCurrentUser())!;
  const db = await loadDatabase(id, membership.teamId);
  if (!db) throw new Error("Not found");
  // Serialize the whole teardown on the DB's lifecycle lock.
  const server = await getServerById(db.serverId);
  const where = server ? server.name : "its server";
  await withKeyedLock(id, async () => {
    // Re-check under the lock: a concurrent delete (or never-finished provision
    // that bailed) may have already removed the row. Idempotent → just return.
    if (!(await databaseExists(id))) return;
    // Tear down the real container + data volume on the owning agent, and hold the
    // delete until the host confirms both are gone.
    let failure: { why: string; retry: string } | null = null;
    try {
      const reason = await teardownDatabaseStack(db);
      if (reason)
        failure = {
          why: `${where} could not remove it: ${reason}`,
          retry: "Try again",
        };
    } catch (e) {
      failure = {
        why: `${where} could not be reached (${e instanceof Error ? e.message : String(e)})`,
        retry: `Try again once ${where} is back online`,
      };
    }
    if (failure) {
      console.warn(`[databases] teardown of ${db.host} failed: ${failure.why}`);
      if (!opts.force)
        throw new Error(
          `${db.name} was NOT deleted: ${failure.why}. Nothing has been removed ` +
            `from Deplo. ${failure.retry}, or delete it anyway and Deplo will ` +
            `keep retrying the teardown on that host.`,
        );
      // Forced: the row goes now, but the stack is not somebody's problem to
      // remember. The queue keeps retrying it until the host confirms both the
      // container and the volume are gone.
      await enqueueTeardowns([
        {
          serverId: db.serverId,
          deployKey: db.host,
          projectLabel: db.id,
          label: db.name,
          teamId: db.teamId,
        },
      ]);
    }
    // One DELETE - the agent teardown above ran OUTSIDE any transaction (PLAN §1 rule
    // (a)).
    await getDb().delete(databasesTable).where(eq(databasesTable.id, id));
    // Tell subscribers: the reload comes back null, ending their streams.
    publishDatabaseChanged(id);
    await recordActivity(
      "database",
      failure
        ? `Deleted database ${db.name} from Deplo, but ${failure.why}. Deplo ` +
            `will retry the teardown of its container and volume on ${where}.`
        : `Deleted database ${db.name}`,
      user.name,
      null,
      db.teamId,
      "database_deleted",
    );
  });
}

/* ------------------------------------------------------------------ */
/* Focused post-create mutations (the database detail page)            */
/* ------------------------------------------------------------------ */

/**
 * Rename a database (Settings → General) - the display label only. The name is
 * unique per team (`databases_team_name_uq`) - checked here for a readable error,
 * and caught again below for the concurrent-rename race.
 */
export async function renameDatabase(id: string, name: string): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const clean = cleanDatabaseName(name);
  const cur = await loadDatabase(id, teamId);
  if (!cur) throw new Error("Not found");
  // No-op: skip the write, the ping and the activity line for an idle Save.
  if (cur.name === clean) return;

  const taken = await getDb()
    .select({ id: databasesTable.id })
    .from(databasesTable)
    .where(
      and(eq(databasesTable.teamId, teamId), eq(databasesTable.name, clean)),
    )
    .limit(1);
  if (taken.length > 0)
    throw new Error(`A database named "${clean}" already exists in this team.`);

  try {
    await getDb()
      .update(databasesTable)
      .set({ name: clean })
      .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)));
  } catch (e) {
    if (isDuplicateNameError(e))
      throw new Error(
        `A database named "${clean}" already exists in this team.`,
      );
    throw e;
  }
  // The header, the grid card and every live status badge read the name off the
  // subscription payload, so they re-title themselves without a reload.
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    `Renamed database ${cur.name} to ${clean}`,
    user.name,
    null,
  );
}

/**
 * Set (or clear) a database's display logo (Settings → General). Null clears it,
 * falling the UI back to the ENGINE's real brand mark, which is why clearing is
 * never a downgrade to a generic glyph, unlike an App's.
 */
export async function updateDatabaseLogo(
  id: string,
  logo: string | null,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const next = logo?.trim() ? logo.trim() : null;
  if (next && !isValidLogoValue(next))
    throw new Error("Unsupported logo image");

  // Conditional, team-scoped UPDATE … RETURNING: distinguishes "changed" from
  // "unchanged" without a second read, exactly like updateAppLogo.
  const updated = await getDb()
    .update(databasesTable)
    .set({ logo: next })
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
        next === null
          ? sql`${databasesTable.logo} is not null`
          : sql`${databasesTable.logo} is distinct from ${next}`,
      ),
    )
    .returning({ id: databasesTable.id });
  if (updated.length === 0) {
    // Nothing changed - tell "not found / not owned" apart from "already that".
    const exists = await loadDatabase(id, membership.teamId);
    if (!exists) throw new Error("Not found");
    return;
  }
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    next ? "Updated database logo" : "Removed database logo",
    user.name,
    null,
  );
}

/**
 * Save a database's per-container resource limits (Settings → Resources).
 */
export async function updateDatabaseResources(
  id: string,
  input: ResourceLimitsInput,
): Promise<void> {
  const { membership } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  const cleaned = cleanResourceLimits(input);
  // Same rule as an App's limits: a NEGATIVE oom_score_adj makes the kernel kill
  // the NEIGHBOURS (other tenants, the platform's own containers) instead of this
  // container when the host runs out of memory, so it needs the host grant.
  if (cleaned.oomScoreAdj != null && cleaned.oomScoreAdj < 0) {
    await requireMountHostVolumes();
  }
  const updated = await getDb()
    .update(databasesTable)
    .set(resourceLimitsToRow(cleaned))
    .where(
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
      ),
    )
    .returning({ id: databasesTable.id });
  if (updated.length === 0) throw new Error("Not found");
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    "Updated database resource limits",
    user.name,
    null,
    membership.teamId,
  );
}

/**
 * A docker image reference the compose can carry as a plain scalar: repo /
 * registry path, optional tag/digest.
 */
function isValidImageRef(ref: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/.test(ref);
}

/**
 * Save a database's expert overrides (Settings → Advanced): a custom image
 * replacing the derived engine image, a custom command replacing the default
 * verbatim, and/or a version (image tag) change.
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
  const { membership } = await requireCapability("configure_databases");
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
      and(
        eq(databasesTable.id, id),
        eq(databasesTable.teamId, membership.teamId),
      ),
    )
    .returning({ id: databasesTable.id });
  if (updated.length === 0) throw new Error("Not found");
  publishDatabaseChanged(id);
  await recordActivity(
    "database",
    "Updated database image settings",
    user.name,
    null,
    membership.teamId,
  );
}

/** The biggest a config file may be. It is a config file, not a data import. */
const MAX_MOUNT_BYTES = 1024 * 1024; // 1 MiB, the same ceiling the Files editor uses

/**
 * Validate + canonicalise a database's whole config-file set.
 */
export function validateDatabaseMounts(
  type: DatabaseType,
  raw: DatabaseMount[],
): DatabaseMount[] {
  const dataDir = DB_DATA_DIRS[type].replace(/\/+$/, "");
  const seenFile = new Set<string>();
  const seenMount = new Set<string>();
  const out: DatabaseMount[] = [];
  for (const m of raw) {
    const filePath = (m.filePath ?? "")
      .trim()
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (!filePath || filePath.startsWith("/"))
      throw new Error(
        `The file name must be relative, for example "postgresql.conf": "${m.filePath}"`,
      );
    if (/[\s:]/.test(filePath))
      throw new Error(
        `A file name cannot contain spaces or ":": "${m.filePath}"`,
      );
    if (filePath.split("/").includes(".."))
      throw new Error(`A file name cannot contain "..": "${m.filePath}"`);

    const mountPath = (m.mountPath ?? "").trim().replace(/\/+$/, "");
    if (!/^\/[^\s:]*$/.test(mountPath) || mountPath.length < 2)
      throw new Error(
        `The path in the container must be absolute, with no spaces or ":": "${m.mountPath}"`,
      );
    if (mountPath.split("/").includes(".."))
      throw new Error(
        `The path in the container cannot contain "..": "${m.mountPath}"`,
      );
    if (mountPath === dataDir || mountPath.startsWith(dataDir + "/"))
      throw new Error(
        `${mountPath} is inside this engine's data directory (${dataDir}). A file there would be stored with the data and backed up with it - put the configuration somewhere else.`,
      );

    const content = m.content ?? "";
    if (Buffer.byteLength(content, "utf8") > MAX_MOUNT_BYTES)
      throw new Error(`${filePath} is too large to save (1 MiB max).`);

    if (seenFile.has(filePath))
      throw new Error(`Duplicate file name: "${filePath}"`);
    if (seenMount.has(mountPath))
      throw new Error(`Duplicate path in the container: "${mountPath}"`);
    seenFile.add(filePath);
    seenMount.add(mountPath);
    out.push({ filePath, content, mountPath });
  }
  return out;
}

/**
 * Replace a database's config files (whole set) and APPLY them. The reroute
 * recreates the container, so the UI says so before the save.
 */
export async function setDatabaseMounts(
  id: string,
  mounts: DatabaseMount[],
): Promise<void> {
  const { teamId } = await requireCapability("configure_databases");
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    const validated = validateDatabaseMounts(cur.type, mounts);

    await getDb().transaction(async (tx) => {
      await tx
        .delete(databaseMountsTable)
        .where(eq(databaseMountsTable.databaseId, id));
      if (validated.length > 0) {
        await tx.insert(databaseMountsTable).values(
          validated.map((m, position) => ({
            databaseId: id,
            position,
            filePath: m.filePath,
            content: m.content,
            mountPath: m.mountPath,
          })),
        );
      }
    });
    publishDatabaseChanged(id);

    // Nothing to write into yet: a database still provisioning renders from the
    // row when it comes up, and one that never did has no stack at all.
    if (cur.status === "provisioning") return;
    const password = parseConnectionPassword(
      decryptSecretOrThrow(cur.connectionStringEnc, "The database password"),
    );
    const next = { ...cur, mounts: validated };
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute({
        slug: cur.host,
        composeYaml: renderDatabaseStackYaml(next, password),
        env: {},
        mounts: mountFilesFor(next),
      });
      if (!res.ok)
        throw new Error(
          `The files were saved but the database could not be updated: ${
            res.error || "the agent refused the change"
          }. Press Redeploy to try again.`,
        );
    } finally {
      conn.close();
    }
  });
  await recordActivity(
    "database",
    "Updated database config files",
    user.name,
    null,
    teamId,
  );
}

/**
 * Restart the database container (stop + start on the owning agent). Same
 * lock/gate discipline as setDatabaseRunning.
 */
export async function restartDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning - wait for it to finish before restarting it.",
      );
    // An engine started on the volume a failed copy emptied does not fail: it
    // initialises a new database over the old one's place. Refuse until the data
    // is here or the loss is accepted.
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    const conn = await connectAgent(cur.serverId);
    try {
      const stop = await conn.stopStack(cur.host);
      if (!stop.ok)
        throw new Error(stop.error || "agent failed to stop the database");
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
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    "Restarted database",
    user.name,
    null,
    teamId,
  );
}

/**
 * Re-render the database's compose from the CURRENT row and reroute it on its
 * owning server - the "apply my pending settings" verb.
 */
export async function redeployDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("control_databases")).teamId;
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning - wait for it to finish before redeploying it.",
      );
    assertDataCopyIntact(cur.name, cur.dataCopyError);
    // Consumed to RENDER the running stack (redis auth rides a compose `--requirepass`
    // flag applied on every boot, so an empty password here would silently disable
    // auth even on a preserved volume). Refuse rather than emit an empty credential.
    const password = parseConnectionPassword(
      decryptSecretOrThrow(cur.connectionStringEnc, "The database password"),
    );
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: mountFilesFor(cur),
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
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    "Redeployed database",
    user.name,
    null,
    teamId,
  );
}

/**
 * DESTRUCTIVE rebuild - the Danger Zone "factory reset". Unlike redeployDatabase
 * this never preserves the volume - use redeploy for the data-preserving recreate.
 */
export async function rebuildDatabase(id: string): Promise<void> {
  const teamId = (await requireCapability("delete_databases")).teamId;
  const user = (await getCurrentUser())!;
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status === "provisioning")
      throw new Error(
        "Database is still provisioning - wait for it to finish before rebuilding it.",
      );
    // Rebuild WIPES the volume and re-inits the engine from these credentials, so an
    // undecryptable password (post `DEPLO_SECRET` rotation) would boot the engine with
    // NO auth - a publicly-exposed redis with an empty password. Refuse instead.
    const password = parseConnectionPassword(
      decryptSecretOrThrow(cur.connectionStringEnc, "The database password"),
    );
    const yaml = renderDatabaseStackYaml(cur, password);
    const conn = await connectAgent(cur.serverId);
    try {
      const down = await conn.destroyStack(cur.host, true);
      if (!down.ok)
        throw new Error(down.error || "agent failed to tear down the database");
      const up = await conn.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: mountFilesFor(cur),
      });
      if (!up.ok) {
        await getDb()
          .update(databasesTable)
          .set({ status: "error" })
          .where(eq(databasesTable.id, id));
        publishDatabaseChanged(id);
        throw new Error(
          up.error || "agent failed to re-provision the database",
        );
      }
    } finally {
      conn.close();
    }
    await getDb()
      .update(databasesTable)
      .set({ status: "running" })
      .where(eq(databasesTable.id, id));
    // A factory reset is the one action that makes an empty volume the INTENDED state,
    // so it also settles a failed migration copy: the data is not coming, and someone
    // confirmed that.
    await clearDataCopyError({ kind: "database", id });
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    "Rebuilt database from scratch (data volume wiped)",
    user.name,
    null,
    teamId,
    "database_rebuilt",
  );
}

/**
 * The per-engine in-engine rotation step. postgres / mysql / mariadb / mongodb
 * persist their users INSIDE the data volume, so changing the compose env alone is
 * a silent no-op on an initialized volume - the engine must be told first, via an
 * exec in the running container. redis (command-carried `--requirepass`) and
 * clickhouse (config regenerated from env on every container start, outside the
 * data volume) rotate through the compose re-render alone. mysql/mariadb rotate
 * BOTH root and the scoped user: root's password == the connection-string password
 * is load-bearing for backups (`dumpUserFor` dumps as root with that password).
 */
export function rotationExecCommand(
  db: Database,
  oldPassword: string,
  newPassword: string,
): string | null {
  const old = shellQuote(oldPassword);
  switch (db.type) {
    case "postgres":
      // Unix-socket auth inside the official image is `trust`, no old password
      // needed; the POSTGRES_USER login is a superuser.
      return `psql -U ${db.username} -d ${db.dbName} -c ${shellQuote(
        `ALTER USER "${db.username}" WITH PASSWORD ${sqlQuote(newPassword)}`,
      )}`;
    case "mysql":
    case "mariadb": {
      const stmts = [
        `ALTER USER IF EXISTS 'root'@'%' IDENTIFIED BY ${sqlQuote(newPassword)};`,
        `ALTER USER IF EXISTS 'root'@'localhost' IDENTIFIED BY ${sqlQuote(newPassword)};`,
        ...(db.username !== "root"
          ? [
              `ALTER USER IF EXISTS '${db.username}'@'%' IDENTIFIED BY ${sqlQuote(newPassword)};`,
            ]
          : []),
        "FLUSH PRIVILEGES;",
      ].join(" ");
      // MariaDB 11 dropped the `mysql*` compatibility symlinks its images used to
      // ship, so the client is only reachable under its own name there. 10.5+ has
      // had `mariadb` for years, which is older than anything deplo offers.
      const client = db.type === "mariadb" ? "mariadb" : "mysql";
      return `${client} -uroot -p${old} -e ${shellQuote(stmts)}`;
    }
    case "mongodb":
      return (
        `mongosh -u ${db.username} -p ${old} --authenticationDatabase admin --quiet ` +
        `--eval ${shellQuote(
          `db.getSiblingDB('admin').changeUserPassword(${jsQuote(db.username)}, ${jsQuote(newPassword)})`,
        )}`
      );
    case "redis":
    case "clickhouse":
      return null; // compose re-render alone rotates
  }
}

/**
 * Wrap a value so a POSIX shell reads it as one literal argument.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A SQL string literal: the standard doubles its own quote. */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** A JavaScript string literal, for the one engine whose client speaks JS. */
function jsQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Rotate a database's engine password. Requires the database to be RUNNING (the
 * exec needs a live engine, and rotating a stopped redis would silently start it).
 */
export async function rotateDatabasePassword(
  id: string,
  input: { password?: string } = {},
): Promise<string> {
  const teamId = (await requireCapability("configure_databases")).teamId;
  const user = (await getCurrentUser())!;

  const newPassword = input.password?.trim() || randomToken(24);
  assertPasswordSafe(newPassword);
  // The POLICY only bounds a password a person CHOSE.
  if (input.password?.trim()) assertPasswordPolicy(newPassword);
  // No extra quote rule any more. It existed because `rotationExecCommand` pasted the
  // password straight into a shell string, and it made rotation stricter than
  // creation for no reason a user could see (create has always accepted a quote).

  let newConn = "";
  await withKeyedLock(id, async () => {
    const cur = await loadDatabase(id, teamId);
    if (!cur) throw new Error("Not found");
    if (cur.status !== "running")
      throw new Error("Start the database before rotating its password.");

    const oldPassword = parseConnectionPassword(
      decryptSecret(cur.connectionStringEnc),
    );
    // No refusal for a quote in the CURRENT password any more: the command is
    // built with `shellQuote`, which carries any byte, so a database created
    // with one is rotatable like every other. It used to be a dead end.
    const execCmd = rotationExecCommand(cur, oldPassword, newPassword);

    // Phase 1 - tell the engine (postgres/mysql/mariadb/mongodb).
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

    // Phase 2 - re-derive the connection string around the UNCHANGED host/port
    // and persist it, then reroute so the compose (env / redis command /
    // healthcheck) agrees with the engine again.
    const exposedHostPort =
      cur.exposedPublicly && cur.exposedPort != null ? cur.exposedPort : null;
    const server =
      exposedHostPort != null
        ? await resolveTeamServer(teamId, cur.serverId)
        : null;
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

    const updated: Database = {
      ...cur,
      connectionStringEnc: encryptSecret(newConn),
    };
    const yaml = renderDatabaseStackYaml(updated, newPassword);
    const conn = await connectAgent(cur.serverId);
    try {
      const res = await conn.reroute({
        slug: cur.host,
        composeYaml: yaml,
        env: {},
        mounts: mountFilesFor(cur),
      });
      if (!res.ok)
        throw new Error(
          `The password was rotated but the container config could not be updated ` +
            `(${res.error || "agent error"}). Run Redeploy to bring it in sync.`,
        );
    } finally {
      conn.close();
    }
    publishDatabaseChanged(id);
  });
  await recordActivity(
    "database",
    "Rotated database password",
    user.name,
    null,
    teamId,
  );
  return newConn;
}
