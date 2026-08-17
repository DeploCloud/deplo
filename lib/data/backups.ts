import "server-only";

import { and, count, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  databases as databasesTable,
  apps as appsTable,
  backupDestination as destinationTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import {
  assembleBackup,
  assembleBackupRun,
  assembleDatabase,
  backupToRow,
  backupRunToRow,
} from "./backup-rows";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import {
  reachesWholeTeam,
  requireActiveTeamId,
  requireCapability,
  requireMembership,
} from "../membership";
import { recordActivity } from "./activity";
import { withKeyedLock } from "./keyed-mutex";
import { dispatchAlert } from "../notify/dispatch";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  requireAppCapability,
} from "./node-access";
import { loadAppGraph, loadTeamApp, appScopeWhere } from "./app-graph-load";
import { setAppStatus } from "./apps";
import { decryptSecret } from "../crypto";
import {
  DEFAULT_SCHEDULE,
  invalidScheduleMessage,
  isValidSchedule,
} from "../schedule";
import { parseConnectionPassword } from "../deploy/database-compose";
import { canonicalTimeZone } from "../crons/cron-tz";
import { BACKUP_RUN_MAX_MS, mapBackupUnsupported } from "../infra/agent-client";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
} from "./destinations";
import {
  backupToDestination,
  deleteFromDestination,
  deleteManyFromDestination,
  openArtifactDownload,
  openUploadRestore,
  restoreFromDestination,
  type BackupOutcome,
} from "./backup-transport";
import { SNIFF_HEAD_BYTES, sniffArtifact } from "../backups/artifact-sniff";
import {
  buildProjectDescriptor,
  type ProjectBackupDescriptor,
} from "./project-backup-descriptor";
import {
  artifactExt,
  buildObjectKey,
  selectDoomedRuns,
  type RunForRetention,
} from "./backup-objectkey";
import type {
  DatabaseDescriptor,
  ProjectDescriptor,
  RestoreEvent,
} from "../agent/gen/agent";
import type {
  Backup,
  BackupRun,
  BackupTargetKind,
  Database,
  DatabaseType,
} from "../types";

/** How many run RECORDS a target keeps per destination, regardless of how many
 *  artifacts its schedule asks for. A failed run owns no artifact, so this is the
 *  only thing bounding a long tail of failures; a schedule keeping MORE than this
 *  many artifacts raises it for itself (see {@link pruneRetention}). */
const MAX_RUNS_PER_TARGET = 50;

/** The ceiling on how many backups one schedule may keep. Not a limit anyone
 *  reaches on purpose — it is there so a typo in a number field can't ask a
 *  bucket to hold a decade of hourly dumps. */
const MAX_RETENTION_COUNT = 365;

/** How many backups a schedule keeps, as the store will have it: at least one
 *  (a schedule that keeps nothing is a schedule that deletes its own work), and
 *  a blank/zero field means the default rather than "none". */
function clampRetention(count: number): number {
  return Math.min(MAX_RETENTION_COUNT, Math.max(1, count || 7));
}

export interface BackupDTO extends Backup {
  databaseName: string | null;
  serviceName: string | null;
  destinationName: string;
  /** The server the backed-up app/database runs on, so the edit dialog can flag
   *  a destination sitting on that same disk. Null if the target is gone. */
  targetServerId: string | null;
}

/** Resolve the display name of a database by id (team-scoped), or null. */
async function databaseNameFor(
  id: string | null,
  teamId: string,
): Promise<string | null> {
  if (!id) return null;
  const rows = await getDb()
    .select({ name: databasesTable.name })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  return rows[0]?.name ?? null;
}

/** The owning server of a team's database `id`, or null. */
async function databaseServerId(
  id: string,
  teamId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ serverId: databasesTable.serverId })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  return rows[0]?.serverId ?? null;
}

/** Whether a team owns the backup destination `id`. */
async function destinationExists(id: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: destinationTable.id })
    .from(destinationTable)
    .where(and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)))
    .limit(1);
  return rows.length > 0;
}

/** Resolve the display name of a backup destination by id (team-scoped), or "". */
async function destinationNameFor(id: string, teamId: string): Promise<string> {
  const rows = await getDb()
    .select({ name: destinationTable.name })
    .from(destinationTable)
    .where(and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)))
    .limit(1);
  return rows[0]?.name ?? "";
}

async function toDTO(b: Backup): Promise<BackupDTO> {
  // Every related collection is relational now: the database/destination names by
  // point lookup, the project name via the project graph (cut-set c).
  const app = b.appId ? await loadAppGraph(b.appId) : null;
  return {
    ...b,
    databaseName: await databaseNameFor(b.databaseId, b.teamId),
    serviceName: app?.name ?? null,
    destinationName: await destinationNameFor(b.destinationId, b.teamId),
    targetServerId: b.appId
      ? (app?.serverId ?? null)
      : b.databaseId
        ? await databaseServerId(b.databaseId, b.teamId)
        : null,
  };
}

export async function listBackups(): Promise<BackupDTO[]> {
  const teamId = await requireActiveTeamId();
  // Newest-first sort pushed into SQL.
  const rows = await getDb()
    .select()
    .from(backupsTable)
    .where(eq(backupsTable.teamId, teamId))
    .orderBy(desc(backupsTable.createdAt));
  // A project-scoped API token sees the schedules of its own apps only: a
  // database schedule belongs to no Project, and an app outside the scope is
  // invisible to it everywhere else too.
  const scoped = await filterBackupsToScope(rows.map(assembleBackup));
  return Promise.all(scoped.map((b) => toDTO(b)));
}

/** Drop the schedules a project-scoped caller can't reach. Inert when unscoped. */
async function filterBackupsToScope<T extends { targetKind: BackupTargetKind; appId: string | null }>(
  rows: T[],
): Promise<T[]> {
  // Either principal: a narrowed token and a member on a limited role reach the
  // same part of the team, so they see the same schedules — and a DATABASE
  // schedule belongs to neither, which is why the filter drops every row whose
  // target is not an app they reach.
  if (await reachesWholeTeam()) return rows;
  const appIds = [
    ...new Set(rows.map((r) => r.appId).filter((id): id is string => !!id)),
  ];
  if (appIds.length === 0) return [];
  // Reach per app, resolved the one way a person's reach is resolved.
  const reach = await appCapabilitiesForTeam(
    (await requireMembership()).teamId,
    (
      await getDb()
        .select({
          id: appsTable.id,
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(and(inArray(appsTable.id, appIds), appScopeWhere()))
    ).map((a) => ({
      id: a.id,
      folderId: a.folderId ?? null,
      projectId: a.projectId ?? null,
      environmentId: a.environmentId ?? null,
    })),
  );
  return rows.filter(
    (r) =>
      r.targetKind === "app" && r.appId && (reach.get(r.appId)?.length ?? 0) > 0,
  );
}

/**
 * Whether a backup TARGET is reachable by this request. A database target never
 * is for a principal who reaches part of the team (a database belongs to no
 * Project); an app target is exactly when the app is. Inert for every unscoped
 * caller, which is every principal on every instance until someone limits one.
 *
 * The app question is asked of {@link appCapabilities}, not of `appInTeam`. The
 * latter's only scope clause is `appScopeWhere()`, which reads `narrowedScope()`
 * — the API TOKEN's reach, and null for every cookie session. It was the whole
 * gate here, and `backupRuns` carries no capability check of its own
 * (`authScopes: { loggedIn: true }`), so a member on a role limited to one
 * project read the full run history of every app in the team: status, timings,
 * byte size, error text, destination id, and an `objectKey` naming the team and
 * the target. `appCapabilities` answers for the human AND the token, and `[]`
 * there is the same answer an app that isn't there gives.
 *
 * None of the five call sites runs inside `getDb().transaction()`, which is what
 * makes this safe: `appCapabilities` opens its own connection, and one issued
 * while a transaction is open hangs under pglite.
 */
async function backupTargetInScope(
  kind: BackupTargetKind,
  targetId: string,
): Promise<boolean> {
  if (await reachesWholeTeam()) return true;
  if (kind !== "app" || !targetId) return false;
  return (await appCapabilities(targetId)).length > 0;
}

/**
 * Trim an incoming cron and REJECT it when it can't be parsed — never repair it.
 * `cronMatches` has to treat an unparseable expression as "never matches" (one
 * bad row must not crash the scheduler tick), so an accepted-but-unparseable
 * schedule is a backup that silently never runs while the UI reports it enabled.
 * An empty string still falls back to the daily default, since that is "the
 * caller didn't choose", not "the caller chose something broken".
 */
function normalizeSchedule(schedule: string): string {
  const expr = (schedule || DEFAULT_SCHEDULE).trim();
  if (!isValidSchedule(expr)) throw new Error(invalidScheduleMessage(expr));
  return expr;
}

/**
 * The zone a schedule's cron is read in.
 *
 * REJECTED, not repaired, for the same reason a bad cron is: `cronMatchesInZone`
 * throws on an unknown zone and the scheduler contains that per row, so an
 * accepted-but-unusable zone is a backup that silently never runs while the UI
 * says it is enabled. Empty falls back to UTC, which is what every schedule made
 * before this was askable already meant.
 */
function normalizeTimezone(tz: string | null | undefined): string {
  const raw = (tz ?? "").trim();
  if (!raw) return "UTC";
  const canonical = canonicalTimeZone(raw);
  if (!canonical) throw new Error(`"${raw}" is not a timezone Deplo recognises`);
  return canonical;
}

export async function createBackup(input: {
  name: string;
  targetKind?: BackupTargetKind;
  databaseId: string | null;
  appId?: string | null;
  destinationId: string;
  schedule: string;
  timezone?: string | null;
  retentionCount: number;
}): Promise<BackupDTO> {
  // The capability is asked ONCE, on the right thing: a database target has no
  // node dimension and stays team-gated, an app target answers to its own node.
  const { membership } =
    (input.targetKind ?? "database") === "app" && input.appId
      ? await requireAppCapability(input.appId, "manage_backups")
      : await requireCapability("manage_backups");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");
  const schedule = normalizeSchedule(input.schedule);
  const timezone = normalizeTimezone(input.timezone);

  const targetKind: BackupTargetKind = input.targetKind ?? "database";
  const appId = input.appId ?? null;
  const databaseId = input.databaseId ?? null;

  // The chosen destination + the target (database OR project) must belong to this
  // team. Exactly one target is set, matching `targetKind`.
  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");
  if (targetKind === "database") {
    if (!databaseId) throw new Error("Select a database to back up");
    // A principal who reaches only part of the team can't see any database, so
    // they can't schedule a dump of one either — same answer their own reads
    // give (`loadDatabase`), and the same one for a narrowed token and a member
    // on a limited role.
    if (!(await reachesWholeTeam()) || !(await databaseNameFor(databaseId, teamId)))
      throw new Error("Database not found");
  } else {
    if (!appId) throw new Error("Select a project to back up");
    if (!(await loadTeamApp(appId, teamId)))
      throw new Error("App not found");
  }

  const b: Backup = {
    id: newId("bkp"),
    teamId,
    name: input.name.trim(),
    targetKind,
    databaseId: targetKind === "database" ? databaseId : null,
    appId: targetKind === "app" ? appId : null,
    destinationId: input.destinationId,
    schedule,
    timezone,
    retentionCount: clampRetention(input.retentionCount),
    lastRunAt: null,
    lastStatus: "never",
    enabled: true,
    createdAt: nowIso(),
  };
  await getDb().insert(backupsTable).values(backupToRow(b));
  await recordActivity(
    "backup",
    `Created backup schedule ${b.name}`,
    user.name,
    null,
    teamId,
  );
  return await toDTO(b);
}

/* ------------------------------------------------------------------ */
/* Descriptor builders                                                 */
/* ------------------------------------------------------------------ */

/**
 * The user the dump tool authenticates as — NOT always the connection string's
 * display user. For every engine except mysql/mariadb this is the database's
 * stored `username`: the account the image created on first init (POSTGRES_USER /
 * MONGO_INITDB_ROOT_USERNAME / CLICKHOUSE_USER, and redis' built-in `default`),
 * each of which the dump tool can authenticate as (pg_dump/mongodump/clickhouse
 * as a superuser; redis-cli auths with just the password). mysql/mariadb are the
 * exception: their compose only ever provisions `root` (MYSQL_ROOT_PASSWORD), and
 * a scoped `MYSQL_USER` lacks the global grants `mysqldump --databases` needs, so
 * they ALWAYS dump as `root`. Root's password IS the connection-string password
 * (the compose sets both to the same secret — see mysqlEnv in database-compose.ts),
 * so `parseConnectionPassword` still supplies it regardless of the string's user.
 * A `switch` (not a map) so a 7th engine forces an explicit decision here.
 */
function dumpUserFor(db: Database): string {
  switch (db.type) {
    case "mysql":
    case "mariadb":
      return "root";
    case "postgres":
    case "mongodb":
    case "redis":
    case "clickhouse":
      return db.username;
  }
}

/**
 * Build the wire {@link DatabaseDescriptor} for a managed database. `container`
 * is the DB stack's deterministic container name (`container_name: db-<name>`
 * in the compose == `db.host`), so the agent execs into exactly it. The dump user
 * is derived by {@link dumpUserFor}; `dbName` is the stored logical database
 * (which the compose `*_DB` env created and the connection string references, so
 * the dump can never target a database that doesn't exist); the password rides
 * decrypted over mTLS.
 */
function databaseDescriptor(db: Database): DatabaseDescriptor {
  return {
    container: db.host,
    dbType: db.type,
    dbName: db.dbName,
    user: dumpUserFor(db),
    password: parseConnectionPassword(decryptSecret(db.connectionStringEnc)),
  };
}

/** Map the structural project descriptor to the wire protobuf shape. */
function toWireProjectDescriptor(d: ProjectBackupDescriptor): ProjectDescriptor {
  return {
    slug: d.slug,
    volumeNames: d.volumeNames,
    includeFiles: d.includeFiles,
    composeYaml: d.composeYaml,
    envSnapshot: d.envSnapshot,
    mounts: d.mounts,
  };
}

/* ------------------------------------------------------------------ */
/* The shared executor: real dump + upload + run history + retention   */
/* ------------------------------------------------------------------ */

/** The resolved target of a run: which server owns it + the wire descriptor. */
interface ResolvedTarget {
  serverId: string;
  kind: BackupTargetKind;
  /** The target's own id (databaseId or appId) — keys the object folder. */
  targetId: string;
  databaseId: string | null;
  appId: string | null;
  dbType: DatabaseType | null;
  database?: DatabaseDescriptor;
  project?: ProjectDescriptor;
  /** A human label for the activity log. */
  label: string;
}

/**
 * Resolve a backup target (database or project) to its owning server + the wire
 * descriptor the agent needs. For a project this reads the rendered stack off the
 * agent (volume names + snapshot), so it may throw {@link AgentUnreachableError}.
 */
async function resolveTarget(
  teamId: string,
  kind: BackupTargetKind,
  databaseId: string | null,
  appId: string | null,
): Promise<ResolvedTarget> {
  if (kind === "database") {
    if (!databaseId) throw new Error("Backup has no database target");
    const dbRows = await getDb()
      .select()
      .from(databasesTable)
      .where(and(eq(databasesTable.id, databaseId), eq(databasesTable.teamId, teamId)))
      .limit(1);
    if (!dbRows[0]) throw new Error("Database not found");
    const db = assembleDatabase(dbRows[0]);
    return {
      serverId: db.serverId,
      kind,
      targetId: db.id,
      databaseId: db.id,
      appId: null,
      dbType: db.type,
      database: databaseDescriptor(db),
      label: `database ${db.name}`,
    };
  }
  if (!appId) throw new Error("Backup has no project target");
  const project = await loadTeamApp(appId, teamId);
  if (!project) throw new Error("App not found");
  const descriptor = await buildProjectDescriptor(project);
  return {
    serverId: project.serverId,
    kind,
    targetId: project.id,
    databaseId: null,
    appId: project.id,
    dbType: null,
    project: toWireProjectDescriptor(descriptor),
    label: `project ${project.name}`,
  };
}

/**
 * The ONE executor every real backup goes through — a schedule's "Run now"
 * (`runBackup`), an ad-hoc project run (`runAppBackup`), and (Step 6) the
 * scheduler. It resolves the target + destination, appends a `running`
 * {@link BackupRun}, dumps+uploads via the OWNING agent (capability-preflighted),
 * records the terminal result, then prunes old artifacts. `backupId` is the
 * owning schedule, or null for an ad-hoc run.
 *
 * Returns the finished `BackupRun`. Throws on a hard failure to resolve/dial
 * (the run is still recorded `failed` first, so the history never lies).
 */
async function executeBackup(
  teamId: string,
  actor: string,
  opts: {
    backupId: string | null;
    kind: BackupTargetKind;
    databaseId: string | null;
    appId: string | null;
    destinationId: string;
    retentionCount: number;
  },
): Promise<BackupRun> {
  const startedAt = nowIso();
  const runId = newId("brun");
  // The target id is known up front (it IS the database/project id), so the run
  // record can be appended BEFORE the expensive resolution (descriptor build,
  // which for a project dials the agent). That way a resolution failure — a bad
  // destination, an unreachable agent while reading the stack — is recorded as a
  // `failed` run, not thrown with no trace: "history never lies", and the Step 6
  // scheduler's unattended runs are visible even when they fail to start.
  const run: BackupRun = {
    id: runId,
    teamId,
    backupId: opts.backupId,
    targetKind: opts.kind,
    databaseId: opts.kind === "database" ? opts.databaseId : null,
    appId: opts.kind === "app" ? opts.appId : null,
    destinationId: opts.destinationId,
    // Denormalized on purpose: the two FK columns above are ON DELETE SET NULL,
    // so deleting the app or database blanks them and nothing is left naming
    // what the artifact on disk belonged to. This one survives, and it is what
    // the orphan sweep uses to reclaim that disk.
    targetId: (opts.kind === "database" ? opts.databaseId : opts.appId) ?? "",
    objectKey: "", // filled once the key is built (after resolution)
    sizeBytes: 0,
    decryptedSizeBytes: null,
    sha256: null,
    orphanedAt: null,
    status: "running",
    error: null,
    startedAt,
    finishedAt: null,
  };
  // START transaction (short): persist the `running` run + stamp the owning
  // schedule. This is the FIRST of the two short transactions; the long agent
  // dump runs BETWEEN them, never inside a tx (PLAN §1 rule (a) — never hold a
  // connection + locks across a gRPC call).
  await getDb().transaction(async (tx) => {
    await tx.insert(backupRunsTable).values(backupRunToRow(run));
    if (opts.backupId) {
      await tx
        .update(backupsTable)
        .set({ lastRunAt: startedAt, lastStatus: "running" })
        .where(eq(backupsTable.id, opts.backupId));
    }
  });

  // Resolve + dump under one try so EVERY failure (resolution, dial, the dump
  // itself) lands on the same `failed`-run path below.
  let label = opts.kind === "database" ? "database" : "app";
  let activityAppId: string | null = opts.kind === "app" ? opts.appId : null;
  // Kept out here for the cancel cleanup below, which runs after the try block
  // that resolves it.
  let targetServerId = "";
  let result: BackupOutcome | null = null;
  let failure: string | null = null;
  let objectKey = "";
  // Registered before the first dial and removed in the `finally` below, so
  // "Stop" can reach this dump for exactly as long as it is running.
  const abort = new AbortController();
  backupRunsInFlight.set(runId, abort);
  let creds: Awaited<ReturnType<typeof getDestinationWithSecretsForTeam>> | null = null;
  try {
    creds = await getDestinationWithSecretsForTeam(teamId, opts.destinationId);
    const target = await resolveTarget(teamId, opts.kind, opts.databaseId, opts.appId);
    label = target.label;
    activityAppId = target.appId;
    targetServerId = target.serverId;
    objectKey = buildObjectKey({
      teamId,
      kind: opts.kind,
      targetId: target.targetId,
      runId,
      // A store artifact is age-encrypted, so its name says so — the `.age` a
      // user would need to know to decrypt it by hand with the recovery key.
      ext: artifactExt(
        opts.kind,
        target.dbType,
        Boolean(creds.destination.ageRecipient),
      ),
      at: new Date(startedAt),
    });
    // Record the resolved key on the running record now, so a crash mid-dump
    // leaves the (single) object's key behind for a sweep. A single UPDATE —
    // outside any transaction (the agent dump follows immediately).
    await getDb()
      .update(backupRunsTable)
      .set({ objectKey })
      .where(eq(backupRunsTable.id, runId));

    // WHERE the bytes go — an S3 bucket, this host's disk, or another server's
    // via the control-plane relay — is entirely backup-transport's problem.
    result = await backupToDestination(
      creds,
      {
        serverId: target.serverId,
        kind: opts.kind,
        database: target.database,
        project: target.project,
      },
      objectKey,
      abort.signal,
    );
    if (!result.ok) failure = result.error || "the agent reported a failed backup";

    // Retention runs on success only (a failed run wrote no object). Best-effort:
    // a prune failure must never fail the backup the operator asked for.
    // An AD-HOC run (no owning schedule) has no retention policy of its own — its
    // `retentionCount` is a fabricated default, and pruning by it would delete
    // artifacts of schedules keeping more on the same target+destination. It
    // prunes to the record cap and nothing tighter.
    if (!failure) {
      try {
        await pruneRetention(
          teamId,
          target,
          creds.destination.id,
          opts.backupId ? opts.retentionCount : MAX_RUNS_PER_TARGET,
        );
      } catch (e) {
        console.warn(
          `[backups] retention prune failed for ${target.label}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    failure = (mapBackupUnsupported(e) as Error).message;
  } finally {
    backupRunsInFlight.delete(runId);
  }

  const finishedAt = nowIso();
  // TERMINAL transaction (short): flip the run to its final status + stamp the
  // schedule. The SECOND of the two short transactions; the agent dump completed
  // above, outside any tx (PLAN §1 rule (a)).
  //
  // A COMPARE-AND-SWAP on `running`, the same shape `commitOutcome` uses for a
  // stopped build: `cancelBackupRun` flips the row on another connection while
  // this is still unwinding, and a cancel that landed at ANY point before this
  // write must win. 0 rows match, the run stays `canceled`, and the block below
  // clears up after it.
  let canceled = false;
  const finished = await getDb().transaction(async (tx): Promise<BackupRun> => {
    const set = failure
      ? { status: "failed" as const, error: failure, finishedAt }
      : {
          status: "success" as const,
          error: null,
          objectKey: result!.objectKey,
          sizeBytes: result!.sizeBytes,
          // 0 means the agent that wrote it predates the field. Stored NULL, so
          // the download can tell "no length recorded" from "an empty file" and
          // simply omits Content-Length rather than advertising nothing.
          decryptedSizeBytes: result!.decryptedSizeBytes || null,
          // Empty means the agent predates integrity checking. Stored NULL, so a
          // restore can say "this backup was taken before Deplo could prove what
          // it wrote" instead of silently skipping the check.
          sha256: result!.sha256 || null,
          finishedAt,
        };
    const updated = await tx
      .update(backupRunsTable)
      .set(set)
      .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.status, "running")))
      .returning();
    // The record can be gone (deleting a target sweeps its run history, and a
    // backup can be in flight when that happens) or no longer `running` (it was
    // canceled). Both come back empty; the second is the one worth knowing about,
    // so it is asked for rather than assumed.
    if (updated.length === 0) {
      const still = await tx
        .select({ status: backupRunsTable.status })
        .from(backupRunsTable)
        .where(eq(backupRunsTable.id, runId))
        .limit(1);
      canceled = still[0]?.status === "canceled";
      return { ...run, ...set } as BackupRun;
    }
    if (opts.backupId) {
      await tx
        .update(backupsTable)
        .set({ lastRunAt: finishedAt, lastStatus: failure ? "failed" : "success" })
        .where(eq(backupsTable.id, opts.backupId));
    }
    return assembleBackupRun(updated[0]!);
  });

  // The cancel already said what happened, in its own Activity entry and to the
  // person who pressed the button. What it could NOT know is whether the dump
  // beat it: a cancel landing in the instant between the agent finishing its
  // upload and the write above leaves a complete artifact at the destination with
  // no successful run pointing at it - an orphan nothing would ever collect,
  // which for a backup is a multi-GB object billed forever. So the artifact goes
  // with the run that was stopped.
  if (canceled) {
    if (!failure && result?.ok && result.objectKey && creds) {
      try {
        const via =
          destinationServerId(creds.destination, targetServerId) ||
          (await anyBackupCapableServer());
        if (via) await deleteFromDestination(creds, via, result.objectKey);
      } catch (e) {
        console.warn(
          `[backups] canceled run ${runId} left ${result.objectKey} behind: ` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    // Thrown, not returned: every caller of this treats a non-success as an
    // error, and "the backup you stopped did not produce one" is the truth.
    throw new Error("This backup was canceled");
  }

  await recordActivity(
    "backup",
    failure
      ? `Backup of ${label} failed: ${failure}`
      : `Backed up ${label} (${formatBytes(finished.sizeBytes)})`,
    actor,
    activityAppId,
    teamId,
  );
  // executeBackup already takes teamId as a parameter, so the scheduler tick —
  // which has no request and no active team — alerts exactly like a manual run.
  dispatchAlert({
    teamId,
    key: failure ? "backup_failed" : "backup_succeeded",
    title: failure ? `Backup of ${label} failed` : `Backed up ${label}`,
    body: failure ?? `${formatBytes(finished.sizeBytes)} uploaded.`,
    path: "/storage",
  });

  if (failure) throw new Error(failure);
  return finished;
}

/**
 * Prune a target's artifacts down to the newest `keepLast` successful runs, and
 * its leftover run RECORDS down to the cap. We delete the OLD artifacts
 * individually, by exact key, rather than by prefix — so a still-current
 * artifact, or another destination sharing the same folder on the same host, is
 * never caught.
 * A `running` run is left alone (it's in flight). Only successful runs own an
 * object worth deleting.
 *
 * SCOPED TO ONE DESTINATION: a target can have runs in more than one place (an
 * ad-hoc run to a different destination, a re-pointed schedule), and we only hold
 * THIS destination's creds here. Pruning across destinations would compute the
 * "newest success to keep" against the wrong set AND drop the OTHER destination's
 * run records while their artifacts survive (an orphan + a vanished restore
 * point). So we consider only runs that live in `destinationId`.
 *
 * A run record is dropped ONLY when its object is gone — actually deleted, or it
 * never owned one (a failed run). A delete that FAILS (threw, or the agent
 * resolved `ok:false` on an S3 hiccup) keeps the record so the next prune retries
 * the object rather than orphaning it.
 */
async function pruneRetention(
  teamId: string,
  target: ResolvedTarget,
  destinationId: string,
  keepLast: number,
): Promise<void> {
  // Candidates carry their `seq` (the bigint identity) so `selectDoomedRuns` ranks
  // newest-first by `(startedAt, seq)` — a same-millisecond tie ordered by
  // timestamp alone could keep/delete the WRONG object (PLAN §5).
  const candidates = await loadRunsForTarget(
    teamId,
    destinationId,
    target.kind,
    target.kind === "database" ? target.databaseId : target.appId,
  );
  const doomed = selectDoomedRuns(candidates, {
    keepLast,
    // A schedule keeping more artifacts than the record cap raises the cap for
    // itself — otherwise the cap would delete the very artifacts it was asked to
    // keep, and the record it needs to find them by.
    maxRecords: Math.max(MAX_RUNS_PER_TARGET, keepLast),
  });
  if (doomed.length === 0) return;

  // A failed run owns no object — its record can always be dropped. A successful
  // run's record is dropped only once its object is confirmed gone.
  const removable = new Set(
    doomed.filter((r) => r.status !== "success" || !r.objectKey).map((r) => r.id),
  );
  const toDelete = doomed.filter((r) => r.status === "success" && r.objectKey);
  if (toDelete.length) {
    const creds = await getDestinationWithSecretsForTeam(teamId, destinationId);
    try {
      // Routed by DESTINATION, not by target: an artifact on another server's
      // disk is only reachable through THAT server's agent, and dialing the
      // workload's host instead would answer "no such file" forever — leaking
      // the artifact while the record quietly disappeared. One connection for
      // the whole sweep: a prune retires up to MAX_RUNS_PER_TARGET artifacts,
      // and every dial mints a fresh client certificate.
      const results = await deleteManyFromDestination(
        creds,
        target.serverId,
        toDelete.map((r) => ({ key: r.objectKey })),
      );
      results.forEach((res, i) => {
        const r = toDelete[i]!;
        // The agent resolves `ok:false` (not a throw) on a destination-side
        // failure, so gate on `ok` — only a confirmed delete (incl. idempotent
        // already-gone) retires the record. A transient failure keeps it for the
        // next prune.
        if (res.ok) removable.add(r.id);
        else
          console.warn(
            `[backups] could not delete artifact ${r.objectKey}: ${res.error || "agent reported failure"} (will retry next prune)`,
          );
      });
    } catch (e) {
      // The whole sweep failed (unreachable agent, too old to serve the verb).
      // Every record stays, and the next prune tries again.
      console.warn(
        `[backups] could not delete artifacts for ${target.label}: ${e instanceof Error ? e.message : String(e)} (will retry next prune)`,
      );
    }
  }

  if (removable.size === 0) return;
  await getDb()
    .delete(backupRunsTable)
    .where(inArray(backupRunsTable.id, [...removable]));
}

/**
 * Load a target's runs in ONE destination, carrying `seq` for retention ranking.
 * Exactly one of `databaseId`/`appId` is set (matching `kind`); team-scoped.
 */
async function loadRunsForTarget(
  teamId: string,
  destinationId: string,
  kind: BackupTargetKind,
  targetId: string | null,
): Promise<RunForRetention[]> {
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, destinationId),
        runTargetWhere(kind, targetId ?? ""),
      ),
    );
  return rows.map((r) => ({ ...assembleBackupRun(r), seq: r.seq }));
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/**
 * Gate a backup operation on its TARGET. An app target answers to its own node —
 * `manage_backups` / `restore_backups` / `delete_backups` can be held on one app
 * or folder alone (ADR-0016) — while a database target has no node dimension and
 * stays team-wide.
 */
async function requireBackupCapability(
  target: { targetKind: BackupTargetKind; appId: string | null },
  cap: "manage_backups" | "restore_backups" | "delete_backups",
): Promise<void> {
  if (target.targetKind === "app" && target.appId) {
    await requireAppCapability(target.appId, cap);
    return;
  }
  // A database belongs to no Project, so a principal who reaches only part of
  // the team reaches none of them — and all three capabilities here survive the
  // clamp (they mean something on an app), so the team-wide `requireCapability`
  // below would let one through. NOT FOUND rather than a scope error, the same answer
  // {@link deleteBackupArtifacts} gives: a scope must never become an oracle for
  // which backup ids exist.
  if (!(await reachesWholeTeam())) throw new Error("Not found");
  await requireCapability(cap);
}

/** Run a backup SCHEDULE now (manual "Run now"). Real dump + upload + history. */
export async function runBackup(id: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await executeBackup(teamId, user.name, {
    backupId: b.id,
    kind: b.targetKind,
    databaseId: b.databaseId,
    appId: b.appId,
    destinationId: b.destinationId,
    retentionCount: b.retentionCount,
  });
}

/** Load one team-scoped backup schedule, assembled, or null. */
async function loadBackup(id: string, teamId: string): Promise<Backup | null> {
  const rows = await getDb()
    .select()
    .from(backupsTable)
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)))
    .limit(1);
  return rows[0] ? assembleBackup(rows[0]) : null;
}

/**
 * Run a backup SCHEDULE unattended (Step 6 scheduler) — the session-free twin of
 * {@link runBackup}. The scheduler tick fires with NO request context, so there
 * is no `requireCapability`/`requireActiveTeamId` to lean on: it has already
 * claimed the cross-process lease and read the enabled schedule straight off the
 * store, so it passes the row's own `teamId` (the authority is the schedule
 * itself, created earlier under `manage_infra`) and a synthetic "Scheduler"
 * actor. Shares the one {@link executeBackup} with the manual paths, so an
 * unattended run records the same `BackupRun` history + retention. Never throws —
 * a failed run is recorded `failed` by the executor and the failure is swallowed
 * so one bad schedule can't abort the tick's remaining backups.
 */
export async function runScheduledBackup(backup: Backup): Promise<void> {
  try {
    await executeBackup(backup.teamId, "Scheduler", {
      backupId: backup.id,
      kind: backup.targetKind,
      databaseId: backup.databaseId,
      appId: backup.appId,
      destinationId: backup.destinationId,
      retentionCount: backup.retentionCount,
    });
  } catch {
    // executeBackup already recorded the run `failed` + logged the activity; the
    // re-thrown error is for the interactive callers, not the scheduler.
  }
}

/**
 * Ad-hoc "Back up now" — one run with no owning schedule, sharing the executor
 * with `backupId: null`. Used by the Backups tab of an app and of a database.
 *
 * With no schedule to read a policy from there is nothing to retain BY: the run
 * prunes to the record cap and nothing tighter, so pressing "Back up now" can
 * never delete the artifacts of a schedule that keeps more on the same
 * target+destination.
 *
 * The gate splits exactly the way {@link requireBackupCapability} splits: an app
 * target answers to its own node — `manage_backups` can be held on one app or
 * folder alone (ADR-0016) — while a database target has no node dimension and
 * stays team-wide.
 */
async function runAdHocBackup(
  kind: BackupTargetKind,
  targetId: string,
  destinationId: string,
): Promise<BackupRun> {
  const { membership } =
    kind === "app"
      ? await requireAppCapability(targetId, "manage_backups")
      : await requireCapability("manage_backups");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (kind === "app") {
    if (!(await loadTeamApp(targetId, teamId))) throw new Error("App not found");
  } else if (
    // A principal who reaches only part of the team can't see any database, so
    // they can't dump one either — the same answer their own reads give.
    !(await reachesWholeTeam()) ||
    !(await databaseNameFor(targetId, teamId))
  ) {
    throw new Error("Database not found");
  }
  if (!(await destinationExists(destinationId, teamId)))
    throw new Error("Select a destination");
  return executeBackup(teamId, user.name, {
    backupId: null,
    kind,
    databaseId: kind === "database" ? targetId : null,
    appId: kind === "app" ? targetId : null,
    destinationId,
    retentionCount: MAX_RUNS_PER_TARGET,
  });
}

/** Ad-hoc "Back up now" for an app. See {@link runAdHocBackup}. */
export function runAppBackup(
  appId: string,
  destinationId: string,
): Promise<BackupRun> {
  return runAdHocBackup("app", appId, destinationId);
}

/** Ad-hoc "Back up now" for a database. See {@link runAdHocBackup}. */
export function runDatabaseBackup(
  databaseId: string,
  destinationId: string,
): Promise<BackupRun> {
  return runAdHocBackup("database", databaseId, destinationId);
}

/**
 * Stream one backup artifact out, decrypted, for the download route.
 *
 * Gated on `restore_backups`, not on `manage_backups`: downloading a dump hands
 * over every byte the target holds, which is the same power a restore gives and
 * strictly more than scheduling one. `restore_backups` is already the sensitive
 * capability the token presets withhold, so this needs no new one.
 *
 * Works for BOTH destination kinds. A bucket artifact used to be refused here
 * with instructions - fetch the object with your own S3 credentials, then
 * decrypt it yourself with the recovery key - which made the Download button
 * dead for every team whose backups live in a bucket, and answered a panel
 * question with a shell. The agent reads the object out and decrypts it on the
 * way, the same as it already did for one on its own disk.
 *
 * Returns the chunks plus the filename to offer. The caller MUST call `close()`
 * once the response is finished — the agent connection stays open behind it.
 */
export async function downloadBackupArtifact(runId: string): Promise<{
  filename: string;
  /**
   * The exact number of bytes the stream below will produce, or null when the
   * run never recorded it (taken before the agent reported it). The route turns
   * it into `Content-Length`, which is the whole difference between a browser
   * that shows a size, a percentage and an estimate and one that shows a
   * download with no end in sight.
   *
   * NOT `sizeBytes`: that is the artifact as STORED, and the agent strips the
   * age layer on the way out. Advertising it would leave the browser waiting for
   * bytes that never come.
   */
  sizeBytes: number | null;
  chunks: AsyncGenerator<Buffer, void, unknown>;
  close: () => void;
}> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)))
    .limit(1);
  if (!runRows[0]) throw new Error("Backup run not found");
  const run = assembleBackupRun(runRows[0]);
  if (run.status !== "success")
    throw new Error("This backup did not complete successfully and cannot be downloaded");
  await requireBackupCapability(run, "restore_backups");

  const creds = await getDestinationWithSecretsForTeam(teamId, run.destinationId);
  const target = await downloadTargetFor(run, teamId);
  const label = target.label;

  // The destination decides WHICH agent fetches it: its own host for a store,
  // the workload's for a bucket. A run whose target has since been deleted has no
  // workload host left, and any provisioned agent can dial a bucket - so the
  // artifact of a deleted app stays downloadable instead of becoming unreachable
  // the moment the thing it backed up is gone.
  const via =
    destinationServerId(creds.destination, target.serverId ?? "") ||
    (await anyBackupCapableServer());
  if (!via)
    throw new Error(
      "No server on this instance can reach the destination this backup is kept in",
    );
  const opened = await openArtifactDownload(creds, via, run.objectKey, run.sha256 ?? "");

  // Recorded HERE, when the stream opens, not when it finishes — and worded for
  // that instant. The audit-relevant fact is that this person was handed the
  // decryption key's output at all; a download they abort halfway still exposed
  // the bytes it delivered, so "started" is the honest verb and waiting for a
  // clean EOF would simply lose the entry for anyone who cancelled.
  await recordActivity(
    "backup",
    `Started downloading a backup of ${label}`,
    user.name,
    run.appId,
    teamId,
  );
  return {
    filename: downloadFilename(label, run),
    sizeBytes: run.decryptedSizeBytes,
    ...opened,
  };
}

/**
 * What a download needs to know about the run's target: what to call the file,
 * and which host runs the thing it came from.
 *
 * Deliberately NOT `resolveTarget`: that one builds the full project descriptor,
 * which dials the owning agent to read the live stack. A download needs a name
 * and a server id, and paying for a round trip to get them would make every
 * download wait on the very host it may not even be talking to.
 *
 * Both are best-effort. A run outlives its target (`app_id` / `database_id` are
 * ON DELETE SET NULL), and an artifact whose app is gone is exactly the one
 * somebody still wants.
 */
async function downloadTargetFor(
  run: BackupRun,
  teamId: string,
): Promise<{ label: string; serverId: string | null }> {
  if (run.targetKind === "database") {
    if (!run.databaseId) return { label: "database", serverId: null };
    const rows = await getDb()
      .select({ name: databasesTable.name, serverId: databasesTable.serverId })
      .from(databasesTable)
      .where(
        and(eq(databasesTable.id, run.databaseId), eq(databasesTable.teamId, teamId)),
      )
      .limit(1);
    return { label: rows[0]?.name ?? "database", serverId: rows[0]?.serverId ?? null };
  }
  const app = run.appId ? await loadAppGraph(run.appId) : null;
  return { label: app?.name ?? "app", serverId: app?.serverId ?? null };
}

/**
 * The name the browser saves the artifact under. The object key is stable and
 * unguessable on purpose (`…/<stamp>-<runId>.tar.gz.age`), which makes it a poor
 * filename — so the download offers `<target>-<stamp>.<ext>`, with the `.age`
 * dropped because what arrives has already been decrypted.
 */
function downloadFilename(label: string, run: BackupRun): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "backup";
  const stamp = run.startedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const ext = run.objectKey.replace(/^.*?\.(?=[a-z])/, "").replace(/\.age$/, "");
  return `${slug}-${stamp}.${ext || "gz"}`;
}

/**
 * Restore a backup IN PLACE from one of its recorded runs. Loads the
 * `BackupRun`, decrypts the destination creds, resolves the owning server, and
 * streams the agent's `Restore` to completion (DB = drop-and-recreate; project =
 * stop → wipe + untar → re-Reroute the snapshot). Guarded by `restore_backups`;
 * the UI adds a typed confirmation. Throws on a failed restore.
 */
export async function restoreBackup(runId: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)))
    .limit(1);
  if (!runRows[0]) throw new Error("Backup run not found");
  const run = assembleBackupRun(runRows[0]);
  if (run.status !== "success")
    throw new Error("This backup did not complete successfully and cannot be restored");
  // Restore is destructive (stop → wipe → untar), so it is gated exactly like the
  // backup it replays — on the run's own target.
  await requireBackupCapability(run, "restore_backups");

  const creds = await getDestinationWithSecretsForTeam(teamId, run.destinationId);
  const target = await resolveTarget(
    teamId,
    run.targetKind,
    run.databaseId,
    run.appId,
  );

  let failure: string | null = null;
  // A restore is stop → wipe → untar → reroute, so it must not interleave with a
  // deploy, a delete, or a second restore of the same app: those all hold
  // `app-lifecycle:<appId>` (see `deleteApp` and the deploy pipeline) and this did
  // not, so a concurrent `compose up` could race the wipe on the same volumes.
  // Database targets have no app-lifecycle key; they serialize on their own
  // provisioning lock, so only the app arm needs it here.
  const withLifecycleLock = async <T>(fn: () => Promise<T>): Promise<T> =>
    run.targetKind === "app" && target.appId
      ? withKeyedLock(`app-lifecycle:${target.appId}`, fn)
      : fn();
  await withLifecycleLock(async () => {
  try {
    // Say what is happening BEFORE it starts. The agent stops the stack, wipes it
    // and untars the snapshot, so for the whole restore the host honestly reports
    // nothing running — which the status derivation, correctly for every other
    // case, painted as a red "Not running" and then "Degraded". Persisted rather
    // than local so it survives a reload and every client sees it, exactly like
    // `stopping`; `setAppStatus` publishes it to the live subscription.
    if (run.targetKind === "app" && target.appId)
      await setAppStatus(target.appId, "restoring");
    const result = await restoreFromDestination(
      creds,
      {
        serverId: target.serverId,
        kind: run.targetKind,
        database: target.database,
        project: target.project,
      },
      run.objectKey,
      // The agent refuses an artifact that no longer hashes to what we recorded
      // when we wrote it. Empty for a run older than integrity checking, which
      // skips the check — see the warning the caller surfaces for those.
      run.sha256 ?? "",
    );
    if (!result.ok) failure = result.error || "the agent reported a failed restore";
  } catch (e) {
    failure = (mapBackupUnsupported(e) as Error).message;
  } finally {
    // The agent's app restore ends in a Reroute, so a clean run leaves the stack
    // up. A failed one leaves it in whatever state the failure found it: "error"
    // is the honest answer, and the telemetry reconciler promotes it back to
    // "active" on its own if the containers are in fact running.
    if (run.targetKind === "app" && target.appId)
      await setAppStatus(target.appId, failure ? "error" : "active");
  }
  });

  await recordActivity(
    "backup",
    failure
      ? `Restore of ${target.label} failed: ${failure}`
      : `Restored ${target.label} from a backup`,
    user.name,
    target.appId,
    teamId,
  );
  dispatchAlert({
    teamId,
    key: failure ? "restore_failed" : "restore_succeeded",
    title: failure
      ? `Restore of ${target.label} failed`
      : `Restored ${target.label}`,
    body: failure ?? "The data is back in place.",
    path: "/storage",
  });
  if (failure) throw new Error(failure);
}

/**
 * Targets with an upload restore streaming into them right now.
 *
 * Two of these at once would untar into the same volumes while the other is
 * wiping them, and neither would be the backup anyone asked for. The second
 * caller is refused rather than queued: it is holding a file open in a browser,
 * and "wait for the other one" is an answer it can act on. Same shape and same
 * reasoning as `uploadsInFlight` in app/api/apps/[id]/upload/route.ts -
 * sufficient because the control plane is a single Node process.
 */
const uploadRestoresInFlight = new Set<string>();

/**
 * The dumps this process is currently driving, by run id, so "Stop" can reach
 * one that is already halfway through a 25 GB tar.
 *
 * Aborting the controller closes the agent connection, which cancels the gRPC
 * call, which cancels the stream context the agent's own write loop checks - so
 * the work actually stops ON THE HOST rather than being merely un-recorded here.
 * That is the difference from `cancelDeployment`, which can only flag the row and
 * let the build finish in the background: a backup's stream is one this process
 * holds open, so it has the lever.
 *
 * MODULE-LEVEL and in-memory, the same shape and the same reasoning as
 * `uploadRestoresInFlight`: the control plane is a single Node process. A run
 * this process does not hold (it restarted, or another instance owns it) is
 * still marked canceled - the record is the part that must always settle, and
 * `reconcileInFlightBackupRuns` sweeps whatever is left.
 */
const backupRunsInFlight = new Map<string, AbortController>();

/**
 * Restore an app or a database from an artifact the operator UPLOADS, rather
 * than from a run this instance recorded.
 *
 * This is the only recovery path that survives losing the control plane. Every
 * other restore starts from a `backup_runs` row: it knows the destination, the
 * object key and the digest. When the instance is gone, or the destination was
 * deleted, those rows are gone too and the artifacts on the disk or in the
 * bucket become unreachable through Deplo - which is exactly the moment a backup
 * is supposed to be worth something.
 *
 * Everything that can refuse, refuses BEFORE the agent is dialed: the capability,
 * the lock, and then the artifact itself (see {@link sniffArtifact} - the wrong
 * file or the wrong key would otherwise be discovered after the stack is stopped
 * and the volumes are wiped).
 *
 * The bytes never touch a disk on the way through. Encrypted uploads travel to
 * the agent exactly as they arrived, with the operator's key alongside them; a
 * PLAINTEXT upload - which is what Deplo's own Download hands out - is wrapped
 * here with an EPHEMERAL age keypair that exists only for the length of this
 * request, because the agent's RestoreFrom has no unencrypted mode.
 *
 * Returns the live event stream, so the caller can relay the agent's own log
 * lines to whoever is watching. All the gates run before it, so a refusal is a
 * thrown error the route can map to a status code, not a failed event. Abandoning
 * the stream (`return()`) is the abort: it runs the same cleanup a finished
 * restore does, which is what a browser closing mid-restore comes down to.
 *
 * `abandon()` is the SAME cleanup, reachable without the stream. It exists
 * because an async generator that was never pulled runs no `finally` at all: a
 * browser that goes away between this resolving and the response's first read
 * would leave the restore running on the host with its lock held for the life of
 * the process, the target parked on `restoring`, and - the part that actually
 * matters - a destructive operation with no entry in the Activity trail.
 * Idempotent, so the route can call both without settling twice.
 */
export async function prepareUploadRestore(input: {
  kind: BackupTargetKind;
  targetId: string;
  /** The destination's recovery key. Ignored for a plaintext artifact; never
   *  stored, never logged, never written to the Activity trail. */
  recoveryKey: string;
  body: ReadableStream<Uint8Array>;
}): Promise<{
  events: AsyncGenerator<RestoreEvent, void, unknown>;
  abandon: () => Promise<void>;
}> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  // Resolved NOW, while the request context still exists. The generator below
  // outlives the route handler that returns its Response, and `getCurrentUser()`
  // reads cookies - asking for it at the end would ask outside the request.
  const user = (await getCurrentUser())!;
  const appId = input.kind === "app" ? input.targetId : null;
  const databaseId = input.kind === "database" ? input.targetId : null;

  // Same gate as restoring a recorded run, and for the same reason: this
  // overwrites live data. For an app it also carries the folder grant.
  await requireBackupCapability({ targetKind: input.kind, appId }, "restore_backups");

  const noun = input.kind === "app" ? "app" : "database";
  const lockKey = `${teamId} ${input.targetId}`;
  if (uploadRestoresInFlight.has(lockKey))
    throw new Error(
      `A restore is already running for this ${noun} - wait for it to finish`,
    );
  uploadRestoresInFlight.add(lockKey);

  let opened: Awaited<ReturnType<typeof openUploadRestore>> | null = null;
  let target: ResolvedTarget;
  try {
    // The artifact is judged FIRST, before the target is even resolved: for an
    // app that resolution already dials the owning agent (the descriptor carries
    // the live stack), and a file that was never a backup should cost nobody a
    // round trip, let alone reach a host.
    //
    // Buffer only the head, then hand the SAME reader to the pump: the bytes
    // already read are re-emitted first and the rest streams straight through,
    // so nothing is ever held in memory but this prefix.
    const reader = input.body.getReader();
    const head = await readUploadHead(reader);
    const { encrypted } = await sniffArtifact(head, {
      kind: input.kind,
      recoveryKey: input.recoveryKey,
    });

    target = await resolveTarget(teamId, input.kind, databaseId, appId);

    const blocked = uploadRestoreRefusal(target);
    if (blocked) throw new Error(blocked);

    const uploaded = uploadChunks(head, reader);
    const wrapped = encrypted
      ? { ageIdentity: input.recoveryKey.trim(), chunks: uploaded }
      : await wrapPlaintextUpload(uploaded);

    opened = await openUploadRestore(target, wrapped.ageIdentity, wrapped.chunks);
    // Only once the agent has the request: a dial that fails must not leave an
    // app parked on "restoring" with nothing running to move it off.
    if (target.appId) await setAppStatus(target.appId, "restoring");
  } catch (e) {
    opened?.close();
    uploadRestoresInFlight.delete(lockKey);
    throw mapBackupUnsupported(e);
  }

  const agent = opened;
  const resolved = target;
  const INTERRUPTED = "the restore was interrupted before it finished";

  // The bookkeeping every ending shares, run exactly once. Deliberately NOT
  // inside the generator's `finally`: that only runs for a generator somebody
  // pulled at least once, and the ending we most need to record - the browser
  // vanishing - is also the one that may never pull.
  let closed = false;
  async function finish(problem: string | null): Promise<void> {
    if (closed) return;
    closed = true;
    // An app left on "restoring" because nobody stayed to watch would never move
    // off it again.
    if (resolved.appId)
      await setAppStatus(resolved.appId, problem ? "error" : "active");
    await recordActivity(
      "backup",
      problem
        ? `Restore of ${resolved.label} from an uploaded file failed: ${problem}`
        : `Restored ${resolved.label} from an uploaded file`,
      user.name,
      resolved.appId,
      teamId,
    );
    dispatchAlert({
      teamId,
      key: problem ? "restore_failed" : "restore_succeeded",
      title: problem
        ? `Restore of ${resolved.label} failed`
        : `Restored ${resolved.label}`,
      body: problem ?? "The data is back in place.",
      path: "/storage",
    });
    agent.close();
    uploadRestoresInFlight.delete(lockKey);
  }

  async function* relay(): AsyncGenerator<RestoreEvent, void, unknown> {
    let failure: string | null = null;
    let settled = false;
    try {
      try {
        for await (const ev of agent.events) {
          if (ev.result) {
            settled = true;
            if (!ev.result.ok)
              failure = ev.result.error || "the agent reported a failed restore";
          }
          yield ev;
        }
        if (!settled) failure = "the agent ended the restore without a result";
      } catch (e) {
        failure = (mapBackupUnsupported(e) as Error).message;
      }
      // The agent yields its own failing result; this covers the cases where it
      // never got to (a dropped connection, a stream that just ended), so the
      // browser always reads a verdict as the last line.
      if (failure && !settled) yield { result: { ok: false, error: failure } };
    } finally {
      await finish(failure ?? (settled ? null : INTERRUPTED));
    }
  }

  return { events: relay(), abandon: () => finish(INTERRUPTED) };
}

/**
 * Why an UPLOADED artifact must not be restored into this target, or null when
 * it may proceed. Pure, so the rule it encodes can be read and tested on its own.
 *
 * NOT the security boundary - that is the `untrusted_config` flag the upload
 * carries, which stops the agent taking compose, env or mounts out of an archive
 * that came from outside the fleet at all. This is the second line, and it is
 * here for a plainer reason: an app that was never deployed on its host has no
 * stack, so there is no container and no volume for the data to land in. Better
 * to say that than to accept the file, unpack it into nothing and report success.
 *
 * The descriptor's compose IS the stack file read off the host, which is why its
 * emptiness is the test for "never deployed here".
 */
export function uploadRestoreRefusal(target: {
  kind: BackupTargetKind;
  project?: { composeYaml: string };
}): string | null {
  if (target.kind !== "app") return null;
  if (target.project?.composeYaml) return null;
  return (
    "This app has never been deployed on its server, so there is no stack to " +
    "restore into. Deploy it once, then restore the backup over it."
  );
}

/**
 * Read at most {@link SNIFF_HEAD_BYTES} from the upload, leaving the reader
 * positioned for the rest. Short reads are normal - a whole artifact smaller
 * than the head simply ends here.
 */
async function readUploadHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  while (total < SNIFF_HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    total += value.length;
  }
  return Buffer.concat(parts);
}

/** The upload as the agent pump wants it: the sniffed head, then the remainder. */
async function* uploadChunks(
  head: Buffer,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Buffer, void, unknown> {
  try {
    if (head.length > 0) yield head;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield Buffer.from(value);
    }
  } finally {
    // Whoever stops reading stops the upload. A restore that fails early (or an
    // agent that drops) otherwise leaves the browser pushing gigabytes into a
    // socket nobody drains; cancelling tears the request body down instead.
    void reader.cancel().catch(() => {});
  }
}

/**
 * Wrap a plaintext upload for an agent that only restores encrypted artifacts.
 *
 * The keypair lives for this request and is never written anywhere: it is not a
 * secret anyone has to keep, only the shape RestoreFrom insists on. Pull-based
 * throughout, so the agent's flow control still paces the browser and the
 * control plane holds one chunk at a time regardless of the file's size.
 */
async function wrapPlaintextUpload(source: AsyncIterable<Buffer>): Promise<{
  ageIdentity: string;
  chunks: AsyncIterable<Buffer>;
}> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(await age.identityToRecipient(identity));
  const iterator = source[Symbol.asyncIterator]();
  const encrypted = await encrypter.encrypt(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    }),
  );
  return { ageIdentity: identity, chunks: streamBuffers(encrypted) };
}

async function* streamBuffers(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Buffer, void, unknown> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield Buffer.from(value);
  }
}

/**
 * The runs for a target's artifact list (project Backups tab / DB restore list),
 * newest first. Exactly one of `appId` / `databaseId` is given; team-scoped.
 */
export async function listBackupRuns(filter: {
  appId?: string;
  databaseId?: string;
}): Promise<BackupRun[]> {
  const teamId = await requireActiveTeamId();
  // A run history is reachable only through a target the caller can reach: an
  // out-of-scope app, or any database, yields nothing for a scoped token.
  if (!(await backupTargetInScope(filter.appId ? "app" : "database", filter.appId ?? filter.databaseId ?? "")))
    return [];
  // Exactly one of appId/databaseId selects the target; neither ⇒ no runs.
  const targetWhere = filter.appId
    ? eq(backupRunsTable.appId, filter.appId)
    : filter.databaseId
      ? eq(backupRunsTable.databaseId, filter.databaseId)
      : null;
  if (!targetWhere) return [];
  // Newest-first by (started_at, seq) DESC, pushed into SQL (matches
  // backup_runs_team_started_idx) — deterministic under a same-ms tie (PLAN §5).
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.teamId, teamId), targetWhere))
    .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq));
  return rows.map(assembleBackupRun);
}

export async function toggleBackup(
  id: string,
  enabled: boolean,
): Promise<void> {
  const teamId = await requireActiveTeamId();
  // Load first so the gate can be asked about the target, not just the team.
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await getDb()
    .update(backupsTable)
    .set({ enabled })
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)));
}

/**
 * Edit a schedule's settings: name, destination, cron expression and retention.
 * The target binding (kind + database/project) is fixed at creation — pointing a
 * schedule at a different target is a different schedule, so it is not editable
 * here. The cron scheduler re-reads each schedule from the store every tick, so a
 * changed `schedule` takes effect on the next tick (no re-registration needed).
 */
export async function updateBackup(
  id: string,
  input: {
    name: string;
    destinationId: string;
    schedule: string;
    timezone?: string | null;
    retentionCount: number;
  },
): Promise<BackupDTO> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");
  const schedule = normalizeSchedule(input.schedule);
  const timezone = normalizeTimezone(input.timezone);

  // The (possibly changed) destination must belong to this team.
  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");

  const cur = await loadBackup(id, teamId);
  if (!cur) throw new Error("Not found");
  await requireBackupCapability(cur, "manage_backups");

  const updated = await getDb()
    .update(backupsTable)
    .set({
      name: input.name.trim(),
      destinationId: input.destinationId,
      schedule,
      timezone,
      retentionCount: clampRetention(input.retentionCount),
    })
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)))
    .returning();
  if (updated.length === 0) throw new Error("Not found");
  const b = assembleBackup(updated[0]!);
  await recordActivity(
    "backup",
    `Updated backup schedule ${b.name}`,
    user.name,
    null,
    teamId,
  );
  return await toDTO(b);
}

export async function deleteBackup(id: string): Promise<void> {
  const teamId = await requireActiveTeamId();
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  await requireBackupCapability(b, "manage_backups");
  await getDb()
    .delete(backupsTable)
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)));
}

/**
 * Stop a backup that is running.
 *
 * Two things happen, and the ORDER is the point. The record is flipped first, as
 * a compare-and-swap on `running`, so the answer is settled the moment the button
 * is pressed and cannot be undone by the dump finishing a second later
 * ({@link executeBackup}'s terminal write is the matching half). Then the dump
 * itself is aborted, which closes the agent connection and cancels the stream
 * context the agent's own write loop checks - so the tar stops and the upload
 * stops, on the host, rather than running to completion into a bucket nobody
 * wants it in.
 *
 * Gated on `manage_backups`, the capability whose own description is "create,
 * edit, disable and RUN backup schedules on demand": stopping a dump you are
 * allowed to start is the same power, and needing a second permission to undo
 * your own click would be a trap rather than a safeguard. It destroys nothing -
 * a canceled run produced no restore point - so it is not `delete_backups`.
 *
 * Returns whether a run was actually stopped: `false` when it had already
 * finished, so the caller can avoid claiming otherwise.
 */
export async function cancelBackupRun(runId: string): Promise<boolean> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)))
    .limit(1);
  if (!runRows[0]) throw new Error("Backup not found");
  const run = assembleBackupRun(runRows[0]);
  await requireBackupCapability(run, "manage_backups");

  // `running` is part of the WHERE, not just a pre-check: a dump that finished
  // between the read above and this write must NOT be retroactively flipped from
  // success to canceled - it produced a real artifact and a real restore point.
  const stopped = await getDb()
    .update(backupRunsTable)
    .set({
      status: "canceled",
      error: `Canceled by ${user.name}`,
      finishedAt: nowIso(),
    })
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.status, "running")))
    .returning({ id: backupRunsTable.id });
  if (stopped.length === 0) return false;

  // The schedule stops reading "Running" at once, rather than waiting out
  // whatever the abort below takes to unwind.
  if (run.backupId)
    await getDb()
      .update(backupsTable)
      .set({ lastStatus: "canceled" })
      .where(and(eq(backupsTable.id, run.backupId), eq(backupsTable.teamId, teamId)));

  // Only this process can hold the stream. One that does not (it restarted, or
  // another instance owns the run) still settles the record above, and
  // `reconcileInFlightBackupRuns` sweeps whatever is left behind.
  backupRunsInFlight.get(runId)?.abort();

  const target = await downloadTargetFor(run, teamId);
  await recordActivity(
    "backup",
    `Canceled a running backup of ${target.label}`,
    user.name,
    run.appId,
    teamId,
  );
  return true;
}

/**
 * Delete ONE backup, artifact and record together.
 *
 * The panel's per-row Delete, and the only way to retire a single restore point:
 * everything else here is wholesale (retention thins a target's history,
 * {@link deleteAllBackupArtifacts} runs when the target itself is deleted). An
 * operator who took a bad backup, or one carrying data that should not have
 * left, needs a way to remove exactly that one.
 *
 * Gated on `delete_backups`, its own capability and not `manage_backups`, for
 * the reason it is its own capability: this is the one verb in the backup
 * surface with no way back and nothing downstream to catch it. Scheduling a dump
 * and destroying the last copy of one are not the same permission, and an admin
 * handing out the first must not be handing out the second. An app's backup
 * answers to the app's own grant (ADR-0016) exactly like every other action on
 * it.
 *
 * The ORDER is the artifact first, the record second, and it is the same rule
 * `pruneRetention` follows: a record dropped while its object survives is an
 * orphan nothing can name any more - not the retention pass, not the sweep,
 * which both start from the row. A delete that fails therefore keeps the row and
 * says so.
 *
 * A `running` run is refused rather than deleted: its artifact does not exist
 * yet, so there is nothing to remove, and taking the row away would let the dump
 * land a file nothing on this instance could ever find.
 */
export async function deleteBackupRun(runId: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)))
    .limit(1);
  if (!runRows[0]) throw new Error("Backup not found");
  const run = assembleBackupRun(runRows[0]);
  await requireBackupCapability(run, "delete_backups");
  if (run.status === "running")
    throw new Error("This backup is still running - wait for it to finish");

  const target = await downloadTargetFor(run, teamId);
  // Only a successful run owns a file. A failed one never wrote anything, so its
  // record goes on its own with nothing to delete first.
  if (run.objectKey && run.status === "success") {
    const creds = await getDestinationWithSecretsForTeam(teamId, run.destinationId);
    // The DESTINATION decides which agent holds the bytes, never the workload's
    // host: an artifact on another server's disk would otherwise be looked for on
    // the app's own, come back "no such file", and leave the file behind while
    // the record disappeared.
    const via =
      destinationServerId(creds.destination, target.serverId ?? "") ||
      (await anyBackupCapableServer());
    if (!via)
      throw new Error(
        "No server on this instance can reach the destination this backup is kept in",
      );
    const res = await deleteFromDestination(creds, via, run.objectKey);
    // The agent resolves `ok:false` rather than throwing for a destination-side
    // refusal, so both shapes have to be checked or a failure reads as success.
    if (!res.ok)
      throw new Error(res.error || "The backup file could not be deleted.");
  }

  await getDb()
    .delete(backupRunsTable)
    .where(and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)));

  await recordActivity(
    "backup",
    `Deleted a backup of ${target.label} from ${formatBytes(run.sizeBytes)}`,
    user.name,
    run.appId,
    teamId,
  );
}

/**
 * Delete a target's artifacts in ONE destination — the "delete artifacts too"
 * branch of DB/project deletion. Returns the count removed; throws when the
 * destination cannot be reached, so the caller can abort rather than delete a
 * target over artifacts it could not clear.
 *
 * BY EXACT KEY, never by prefix, and that is the whole shape of this function.
 * A prefix is `deplo/<team>/<kind>/<target>/`, which says nothing about WHICH
 * destination wrote what is under it — and two `server` destinations on the same
 * host with no custom path resolve to the SAME managed folder. So the prefix
 * sweep, which believed itself scoped to one destination, deleted the other's
 * artifacts too and then dropped only its own run records: the exact pair of an
 * orphaned file and a restore point pointing at nothing that the scoping was
 * there to prevent. That is not a rare shape either — the team's auto-seeded
 * default lives in the managed folder, and the second destination someone adds
 * by hand usually lands beside it.
 *
 * The keys come from `backup_runs`, which is the only record of what this
 * destination actually wrote. A run whose delete FAILS keeps its record so the
 * next attempt can find the file again.
 */
export async function deleteBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  serverId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  // Destructive, and gated on the view floor alone — so the scope check has to
  // be here: a caller-supplied targetId must be one this request can reach.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  const creds = await getDestinationWithSecretsForTeam(teamId, input.destinationId);

  // Every run this target has in this destination. A `running` one is in flight
  // and owns no committed artifact yet; a failed one owns none at all.
  const runs = await getDb()
    .select({ id: backupRunsTable.id, objectKey: backupRunsTable.objectKey, status: backupRunsTable.status })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, input.destinationId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  const withArtifacts = runs.filter((r) => r.status === "success" && r.objectKey);

  // The deletes (RPC) run BEFORE the record delete — outside any tx.
  // `input.serverId` is the TARGET's host and is only a fallback here: for a
  // server destination the artifacts live on the destination's own disk, so
  // deleteManyFromDestination dials that one instead.
  const results = await deleteManyFromDestination(
    creds,
    input.serverId,
    withArtifacts.map((r) => ({ key: r.objectKey })),
  );
  // The agent resolves `ok:false` (not a throw) on a destination-side failure.
  // One that fails is the whole call's failure: the caller's contract is "either
  // this target's artifacts are gone or you are told", and a partial sweep that
  // reported success would delete the target over a folder still holding data.
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0)
    throw new Error(
      failed[0]!.error ||
        `Could not delete ${failed.length} backup artifact${failed.length === 1 ? "" : "s"}.`,
    );
  const deleted = results.reduce((n, r) => n + r.deleted, 0);

  // Drop the run records for THIS target in THIS destination — records in other
  // destinations (whose artifacts survive) stay. Runs that never owned a file go
  // too: nothing is orphaned by removing them.
  //
  // EXCEPT a `running` one. Its artifact does not exist yet, so it was not in the
  // sweep above — and deleting its record means the dump finishes, the file
  // lands, and nothing anywhere names it: a permanent orphan the sweep cannot see
  // either, because there is no row left to find it by. (The terminal write would
  // also come back empty.) Keeping the record leaves the run to fail or finish
  // normally, and the FK cascade then turns it into an ordinary orphan.
  const removable = runs.filter((r) => r.status !== "running").map((r) => r.id);
  if (removable.length > 0)
    await getDb()
      .delete(backupRunsTable)
      .where(inArray(backupRunsTable.id, removable));
  return deleted;
}

/**
 * The `backup_runs` WHERE clause selecting one target (database OR project).
 *
 * On `target_id`, NOT on the `database_id` / `app_id` FKs, and that is the fix
 * for a whole class of silently leaked disk: those two are ON DELETE SET NULL,
 * so the moment an app or database was deleted every one of its runs stopped
 * matching here. Retention no longer saw them, no screen listed them, and their
 * artifacts sat on the destination forever with nothing left that could name
 * them. `target_id` is written at insert and outlives the row it names.
 */
function runTargetWhere(kind: BackupTargetKind, targetId: string) {
  return and(
    eq(backupRunsTable.targetKind, kind),
    eq(backupRunsTable.targetId, targetId),
  )!;
}

/**
 * How many stored backup artifacts a single target still has — one per SUCCESSFUL
 * run (a `failed`/`running` run never wrote one). Team-scoped; exactly one target
 * selected by kind.
 *
 * Drives the delete dialog's "also delete backup artifacts" affordance, which is
 * hidden at 0: offering an operator a bucket sweep with nothing to sweep is both
 * confusing and the source of the "$targetKind got invalid value" regression the
 * checkbox used to fire regardless of whether any artifact existed.
 */
export async function countBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    return 0;
  const [row] = await getDb()
    .select({ n: count() })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * The distinct destinations a target has runs in — so a "delete artifacts too"
 * caller can sweep EVERY one (calling {@link deleteBackupArtifacts} once per
 * destination) rather than just the one a single schedule used. Team-scoped.
 */
export async function backupDestinationsForTarget(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<string[]> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    return [];
  const rows = await getDb()
    .selectDistinct({ destinationId: backupRunsTable.destinationId })
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.teamId, teamId), runTargetWhere(input.kind, input.targetId)),
    );
  return rows.map((r) => r.destinationId);
}

/**
 * Wipe EVERY artifact of one target across all the destinations it ever ran to —
 * the "also delete backup artifacts" branch of DB/project deletion. Sweeps each
 * distinct destination via {@link deleteBackupArtifacts}. Returns the total
 * removed plus any destinations whose sweep failed.
 *
 * Capability mirrors the target's OWN delete gate so this can never become a
 * privilege escalation OR an unexpected hard block: a database's artifacts need
 * `delete_databases` (like `deleteDatabase`), an app's need `delete_apps` (like
 * `deleteApp`). Run BEFORE the target row is deleted, so it still resolves to
 * its owning server.
 *
 * A partial failure is NOT swallowed: the call returns the failing destinations,
 * and the GraphQL resolver throws on a non-empty `failedDestinations` so the
 * delete flow aborts (a half-done "delete with backups" that silently leaves a
 * destination full is worse than a retryable no-op).
 */
export async function deleteAllBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<{ deleted: number; failedDestinations: string[] }> {
  // Gate on the same capability the target's own deletion requires, enforced in
  // the data layer (the real gate) rather than relying on a single static
  // GraphQL authScope that can't vary by kind.
  const { teamId } =
    input.kind === "app"
      ? await requireAppCapability(input.targetId, "delete_apps")
      // `delete_databases`, matching `deleteDatabase` — NOT `manage_backups`.
      // This wipes every restore point a database has, with no undo, and
      // `manage_backups` says "create, edit, disable and run backup schedules"
      // and is handed out on that reading. Whoever may destroy the database may
      // destroy its backups; nobody else.
      : await requireCapability("delete_databases");
  // `manage_backups` survives the project clamp, so the database branch above
  // would otherwise let a narrowed token wipe a target it can't reach. Mirrors
  // the check in {@link deleteBackupArtifacts}.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  // Resolve the owning server straight off the target row — no agent round-trip
  // (a project's full descriptor needs `readStack`, which we don't need just to
  // delete objects). A missing/foreign row yields no server and nothing to do.
  const serverId =
    input.kind === "database"
      ? ((await databaseServerId(input.targetId, teamId)) ?? null)
      : ((await loadTeamApp(input.targetId, teamId))?.serverId ?? null);

  const destinations = await backupDestinationsForTarget(input);
  if (destinations.length === 0) return { deleted: 0, failedDestinations: [] };
  if (!serverId) {
    // The target row is gone (or never ours) yet run records linger — there is no
    // owning agent left to reach the buckets. Drop the orphaned records so history
    // matches reality, and report the destinations as failed (their objects can't
    // be swept from here) so the caller doesn't claim a clean wipe.
    await getDb()
      .delete(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.teamId, teamId),
          runTargetWhere(input.kind, input.targetId),
        ),
      );
    return { deleted: 0, failedDestinations: destinations };
  }

  let deleted = 0;
  const failedDestinations: string[] = [];
  for (const destinationId of destinations) {
    try {
      deleted += await deleteBackupArtifacts({
        kind: input.kind,
        targetId: input.targetId,
        destinationId,
        serverId,
      });
    } catch (e) {
      console.warn(
        `[backups] failed to delete artifacts for ${input.kind} ${input.targetId} ` +
          `in destination ${destinationId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      failedDestinations.push(destinationId);
    }
  }
  return { deleted, failedDestinations };
}

/**
 * How long the backups of a DELETED app or database are kept before the sweep
 * reclaims their disk.
 *
 * Deleting a target offers "also delete the backup artifacts", off by default —
 * keeping them is the safe answer, and it is the right one: the backups of the
 * thing you just deleted are exactly what you want on the day you regret it. But
 * "keep" used to mean "keep forever, invisibly": nothing listed them, retention
 * could not see them, and on a `server` destination they were disk nobody could
 * ever reclaim without a shell — which is the one thing the platform promises
 * you never need.
 *
 * So they are kept, for a month, and then let go. Long enough to cover the
 * regret, bounded enough that a busy team's storage box does not fill with the
 * backups of apps that no longer exist.
 */
const ORPHAN_ARTIFACT_KEEP_MS = 30 * 24 * 60 * 60_000;

/**
 * Any provisioned server whose agent can reach a BUCKET.
 *
 * A store destination dials its own host, but an S3 one is normally reached
 * through the WORKLOAD's agent — and in a sweep the workload is exactly what no
 * longer exists. Any backup-capable agent can talk to a bucket (it needs network
 * and credentials, not Docker), which is the same reasoning `testDestination`
 * already uses to probe one. Raw query rather than `listAllServers`, because the
 * sweep runs on a scheduler tick with no session to resolve.
 */
async function anyBackupCapableServer(): Promise<string | null> {
  const rows = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(isNotNull(serversTable.agentCertFingerprint))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * How many artifacts one sweep will try to remove. It runs daily and is
 * idempotent, so a backlog simply drains over a few days — and the cap is what
 * keeps a first sweep on a long-lived instance from holding the scheduler's
 * lease through thousands of agent round trips.
 */
const ORPHAN_SWEEP_BATCH = 500;

/**
 * Reclaim the artifacts of targets that no longer exist.
 *
 * A run's `database_id` / `app_id` are ON DELETE SET NULL, so a deleted target
 * leaves runs pointing at nothing — that is the shape this looks for, and it is
 * the ONLY shape, so a live target's artifacts are never in scope no matter how
 * old.
 *
 * TWO PASSES, and the split is the whole point. The first time a run is seen
 * orphaned it is STAMPED and left alone; only a stamp older than
 * {@link ORPHAN_ARTIFACT_KEEP_MS} is acted on. Measuring the window from
 * `started_at` instead — which is what this did first — meant an app deleted
 * TODAY with two-month-old backups was already past it, so "keep the backup
 * files", the default and an explicit choice, deleted them within the day. It
 * also meant the first sweep after the feature shipped would have removed every
 * artifact already orphaned on the instance, as a side effect of an upgrade.
 *
 * Stamping HERE rather than in the delete paths is deliberate: a target can go
 * through `deleteApp`, `deleteDatabase`, a folder or team cascade, or a FK the
 * database resolves with nothing in the app watching. One observer catches all
 * of them.
 *
 * Best-effort and idempotent, like every other prune here: a record is dropped
 * only once its artifact is confirmed gone, so a destination that is down today
 * simply gets swept tomorrow. Grouped by destination so a sweep opens one
 * connection per destination rather than one per artifact.
 *
 * Runs on the backup scheduler's tick, under the same lease, so exactly one
 * control plane does it however many are running.
 */
export async function sweepOrphanedBackupArtifacts(): Promise<number> {
  const orphanedTargets = and(
    isNull(backupRunsTable.appId),
    isNull(backupRunsTable.databaseId),
  );

  // PASS 1 — start the clock on anything newly orphaned. Nothing is deleted on
  // the tick that first notices a target is gone.
  await getDb()
    .update(backupRunsTable)
    .set({ orphanedAt: nowIso() })
    .where(and(orphanedTargets, isNull(backupRunsTable.orphanedAt)));

  // PASS 2 — act on the ones that have been orphaned long enough.
  const cutoff = new Date(Date.now() - ORPHAN_ARTIFACT_KEEP_MS).toISOString();
  const orphaned = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(orphanedTargets, lt(backupRunsTable.orphanedAt, cutoff)))
    .orderBy(backupRunsTable.orphanedAt)
    .limit(ORPHAN_SWEEP_BATCH);
  if (orphaned.length === 0) return 0;

  // (team, destination) is the unit a delete can be issued for: the creds and the
  // agent to dial both come from the destination, and the team is what scopes the
  // read of it.
  const byDestination = new Map<string, typeof orphaned>();
  for (const r of orphaned) {
    const key = `${r.teamId} ${r.destinationId}`;
    byDestination.set(key, [...(byDestination.get(key) ?? []), r]);
  }

  let reclaimed = 0;
  for (const [key, runs] of byDestination) {
    const [teamId, destinationId] = key.split(" ") as [string, string];
    // A record with no artifact (a failed run, or one that never got a key) is
    // dropped outright: there is nothing on any disk to confirm.
    const removable = new Set(
      runs.filter((r) => r.status !== "success" || !r.objectKey).map((r) => r.id),
    );
    const withArtifacts = runs.filter((r) => r.status === "success" && r.objectKey);
    if (withArtifacts.length > 0) {
      try {
        const creds = await getDestinationWithSecretsForTeam(teamId, destinationId);
        const via = creds.destination.serverId ?? (await anyBackupCapableServer());
        if (!via) {
          console.warn(
            `[backups] orphan sweep found no server able to reach destination ` +
              `${destinationId}; will retry`,
          );
          continue;
        }
        const results = await deleteManyFromDestination(
          creds,
          via,
          withArtifacts.map((r) => ({ key: r.objectKey })),
        );
        results.forEach((res, i) => {
          if (!res.ok) return; // keep the record; the next sweep retries
          removable.add(withArtifacts[i]!.id);
          reclaimed += res.deleted;
        });
      } catch (e) {
        console.warn(
          `[backups] orphan sweep could not reach destination ${destinationId}: ` +
            `${e instanceof Error ? e.message : String(e)} (will retry)`,
        );
      }
    }
    if (removable.size > 0)
      await getDb()
        .delete(backupRunsTable)
        .where(inArray(backupRunsTable.id, [...removable]));
  }
  if (reclaimed > 0)
    console.log(`[deplo] reclaimed ${reclaimed} backup artifact(s) of deleted targets`);
  return reclaimed;
}

/**
 * The longest a real backup could still be running before we call a `running`
 * record orphaned. Derived from the agent RPC's own deadline
 * ({@link BACKUP_RUN_MAX_MS}) plus slack for the dial and the terminal write,
 * rather than picked next to it: the two used to be independent numbers that
 * disagreed with a comment claiming a third, so a run could be declared dead
 * while its RPC was still legally running.
 */
const RUN_ORPHAN_AFTER_MS = BACKUP_RUN_MAX_MS;

/**
 * Reconcile backup runs orphaned by a control-plane restart — the backup analogue
 * of `reconcileInFlightDeployments`. A run is persisted `running` BEFORE the long
 * dump and only flipped at the terminal mutate; if the process dies in between,
 * the record (and any owning schedule's `lastStatus`) is stuck `running` forever,
 * and retention never prunes a running run. Run once at boot (instrumentation.ts,
 * Node runtime) and safe to call periodically: it only touches runs older than
 * {@link RUN_ORPHAN_AFTER_MS}, so it can never race a genuinely in-flight run.
 * Returns how many it reconciled.
 */
export async function reconcileInFlightBackupRuns(): Promise<number> {
  const cutoffIso = new Date(Date.now() - RUN_ORPHAN_AFTER_MS).toISOString();
  const finishedAt = nowIso();
  const reconciled = await getDb().transaction(async (tx) => {
    // Flip stale `running` runs to `failed` (the partial index
    // `backup_runs_running_idx` serves this). RETURNING their owning schedule ids
    // so the second statement can settle those schedules.
    const flipped = await tx
      .update(backupRunsTable)
      .set({
        status: "failed",
        error: "Interrupted by a control-plane restart and marked failed.",
        finishedAt,
      })
      .where(
        and(
          eq(backupRunsTable.status, "running"),
          lt(backupRunsTable.startedAt, cutoffIso),
        ),
      )
      .returning({
        backupId: backupRunsTable.backupId,
        // Carried out of the bulk flip so the alert below can be raised once per
        // team instead of once per interrupted run.
        teamId: backupRunsTable.teamId,
      });

    const orphanedBackupIds = [
      ...new Set(flipped.map((r) => r.backupId).filter((id): id is string => !!id)),
    ];
    // A schedule stuck on `lastStatus:"running"` for an orphaned run settles too.
    if (orphanedBackupIds.length > 0) {
      await tx
        .update(backupsTable)
        .set({ lastStatus: "failed" })
        .where(
          and(
            eq(backupsTable.lastStatus, "running"),
            inArray(backupsTable.id, orphanedBackupIds),
          ),
        );
    }
    return flipped;
  });
  if (reconciled.length > 0) {
    const perTeam = new Map<string, number>();
    for (const r of reconciled)
      if (r.teamId) perTeam.set(r.teamId, (perTeam.get(r.teamId) ?? 0) + 1);
    for (const [teamId, n] of perTeam)
      dispatchAlert({
        teamId,
        key: "backup_failed",
        title: `${n} backup run${n > 1 ? "s were" : " was"} interrupted`,
        body: "Deplo restarted while they were running. They are marked failed.",
        path: "/storage",
      });
    console.warn(
      `[deplo] reconciled ${reconciled.length} interrupted backup run(s) to failed on startup`,
    );
  }
  return reconciled.length;
}

/** Compact human bytes for the activity log ("12.3 MB"). */
function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
