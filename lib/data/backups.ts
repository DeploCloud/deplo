import "server-only";

// https://deplo.build/docs/guides/data/backups-and-restore

import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
} from "drizzle-orm";

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
import { decryptSecretOrThrow } from "../crypto";
import {
  DEFAULT_SCHEDULE,
  backupTooFrequent,
  invalidScheduleMessage,
  isValidSchedule,
} from "../schedule";
import { parseConnectionPassword } from "../deploy/database-compose";
import { deployNetwork } from "../deploy/network";
import { retargetStackNetwork } from "../deploy/compose-stack";
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
  BackupRunStatus,
  BackupTargetKind,
  Database,
  DatabaseType,
} from "../types";

/**
 * How many run RECORDS a target keeps per destination, regardless of how many
 * artifacts its schedule asks for.
 */
const MAX_RUNS_PER_TARGET = 50;

/** The ceiling on how many backups one schedule may keep. Not a limit anyone
 *  reaches on purpose - it is there so a typo in a number field can't ask a
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
  /** Size of the newest artifact this schedule still holds, so a card can say how
   *  big a backup actually is. Null until one succeeds. */
  lastSizeBytes: number | null;
  /** The target's own display logo and, for a database, its engine - so the list
   *  shows the thing being backed up, not a generic glyph. */
  databaseType: DatabaseType | null;
  databaseLogo: string | null;
  serviceLogo: string | null;
  /** The app's slug, the address of its own Backups tab. Null if it is gone. */
  serviceSlug: string | null;
  /** The server the backed-up app/database runs on, so the edit dialog can flag
   *  a destination sitting on that same disk. Null if the target is gone. */
  targetServerId: string | null;
}

/** Resolve the display name of a database by id (team-scoped), or null. */
async function databaseFor(
  id: string | null,
  teamId: string,
): Promise<{ name: string; type: DatabaseType; logo: string | null } | null> {
  if (!id) return null;
  const rows = await getDb()
    .select({
      name: databasesTable.name,
      type: databasesTable.type,
      logo: databasesTable.logo,
    })
    .from(databasesTable)
    .where(and(eq(databasesTable.id, id), eq(databasesTable.teamId, teamId)))
    .limit(1);
  const row = rows[0];
  return row
    ? { name: row.name, type: row.type as DatabaseType, logo: row.logo }
    : null;
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
    .where(
      and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)),
    )
    .limit(1);
  return rows.length > 0;
}

/** Resolve the display name of a backup destination by id (team-scoped), or "". */
async function destinationNameFor(id: string, teamId: string): Promise<string> {
  const rows = await getDb()
    .select({ name: destinationTable.name })
    .from(destinationTable)
    .where(
      and(eq(destinationTable.id, id), eq(destinationTable.teamId, teamId)),
    )
    .limit(1);
  return rows[0]?.name ?? "";
}

async function toDTO(
  b: Backup,
  lastSizeBytes: number | null = null,
): Promise<BackupDTO> {
  // Every related collection is relational now: the database/destination names by
  // point lookup, the project name via the project graph (cut-set c).
  const app = b.appId ? await loadAppGraph(b.appId) : null;
  const database = await databaseFor(b.databaseId, b.teamId);
  return {
    ...b,
    lastSizeBytes,
    databaseName: database?.name ?? null,
    databaseType: database?.type ?? null,
    databaseLogo: database?.logo ?? null,
    serviceName: app?.name ?? null,
    serviceLogo: app?.logo ?? null,
    serviceSlug: app?.slug ?? null,
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
  const sizes = await newestArtifactSizes(
    teamId,
    scoped.map((b) => b.id),
  );
  return Promise.all(scoped.map((b) => toDTO(b, sizes.get(b.id) ?? null)));
}

/**
 * The newest surviving artifact of each schedule, in one read. Ranked on `seq`
 * rather than `finished_at`, which is nullable.
 */
async function newestArtifactSizes(
  teamId: string,
  ids: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = await getDb()
    .selectDistinctOn([backupRunsTable.backupId], {
      backupId: backupRunsTable.backupId,
      sizeBytes: backupRunsTable.sizeBytes,
    })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.status, "success"),
        inArray(backupRunsTable.backupId, ids),
      ),
    )
    .orderBy(backupRunsTable.backupId, desc(backupRunsTable.seq));
  for (const r of rows) if (r.backupId) out.set(r.backupId, r.sizeBytes);
  return out;
}

/** Drop the schedules a project-scoped caller can't reach. Inert when unscoped. */
async function filterBackupsToScope<
  T extends { targetKind: BackupTargetKind; appId: string | null },
>(rows: T[]): Promise<T[]> {
  // Either principal: a narrowed token and a member on a limited role reach the same
  // part of the team, so they see the same schedules, and a DATABASE schedule
  // belongs to neither, which is why the filter drops every row whose target is not
  // an app they reach.
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
      r.targetKind === "app" &&
      r.appId &&
      (reach.get(r.appId)?.length ?? 0) > 0,
  );
}

/**
 * Whether a backup TARGET is reachable by this request. A database target never is
 * for a principal who reaches part of the team (a database belongs to no Project);
 * an app target is exactly when the app is.
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
 * Trim an incoming cron and REJECT it when it can't be parsed, never repair it.
 */
function normalizeSchedule(schedule: string): string {
  const expr = (schedule || DEFAULT_SCHEDULE).trim();
  if (!isValidSchedule(expr)) throw new Error(invalidScheduleMessage(expr));
  // A dump every minute of a big volume pins the host's disk and the whole
  // instance's backup scheduler behind it: at most every 15 minutes.
  if (backupTooFrequent(expr))
    throw new Error(
      'A backup can run at most every 15 minutes - pick specific minutes, e.g. "0,30 * * * *".',
    );
  return expr;
}

/**
 * The zone a schedule's cron is read in. Empty falls back to UTC, which is what
 * every schedule made before this was askable already meant.
 */
function normalizeTimezone(tz: string | null | undefined): string {
  const raw = (tz ?? "").trim();
  if (!raw) return "UTC";
  const canonical = canonicalTimeZone(raw);
  if (!canonical)
    throw new Error(`"${raw}" is not a timezone Deplo recognises`);
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
    // A principal who reaches only part of the team can't see any database, so they
    // can't schedule a dump of one either - same answer their own reads give
    // (`loadDatabase`), and the same one for a narrowed token and a member on a limited
    // role.
    if (!(await reachesWholeTeam()) || !(await databaseFor(databaseId, teamId)))
      throw new Error("Database not found");
  } else {
    if (!appId) throw new Error("Select a project to back up");
    if (!(await loadTeamApp(appId, teamId))) throw new Error("App not found");
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
    b.appId,
    teamId,
    null,
    b.databaseId,
  );
  return await toDTO(b);
}

/* ------------------------------------------------------------------ */
/* Descriptor builders                                                 */
/* ------------------------------------------------------------------ */

/**
 * The user the dump tool authenticates as, NOT always the connection string's
 * display user.
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
 * Build the wire {@link DatabaseDescriptor} for a managed database.
 */
function databaseDescriptor(db: Database): DatabaseDescriptor {
  return {
    container: db.host,
    dbType: db.type,
    dbName: db.dbName,
    user: dumpUserFor(db),
    password: parseConnectionPassword(
      decryptSecretOrThrow(db.connectionStringEnc, "The database password"),
    ),
  };
}

/** Map the structural project descriptor to the wire protobuf shape. */
function toWireProjectDescriptor(
  d: ProjectBackupDescriptor,
  network: string,
): ProjectDescriptor {
  return {
    slug: d.slug,
    volumeNames: d.volumeNames,
    includeFiles: d.includeFiles,
    // The stack file was read off the HOST, so it can still name the network the
    // app had before it moved - or one the cleanup has reclaimed since. The agent
    // writes this YAML verbatim, so the retarget has to happen here.
    composeYaml: retargetStackNetwork(d.composeYaml, network),
    envSnapshot: d.envSnapshot,
    mounts: d.mounts,
    // The app's network TODAY, not the snapshot's: a restore ends in a Reroute, and
    // the app may have moved Environment since the backup was taken.
    network,
  };
}

/* ------------------------------------------------------------------ */
/* The shared executor: real dump + upload + run history + retention   */
/* ------------------------------------------------------------------ */

/** The resolved target of a run: which server owns it + the wire descriptor. */
interface ResolvedTarget {
  serverId: string;
  kind: BackupTargetKind;
  /** The target's own id (databaseId or appId) - keys the object folder. */
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
      .where(
        and(
          eq(databasesTable.id, databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      )
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
    project: toWireProjectDescriptor(descriptor, deployNetwork(project)),
    label: `project ${project.name}`,
  };
}

/**
 * Refuse to dump a workload that is already being dumped: two runs five seconds
 * apart tarred one 61 GB volume in parallel. Read from the ROW, so a second
 * control plane on the same database is caught, and bounded by the same window.
 */
async function assertNotAlreadyBackingUp(
  teamId: string,
  targetId: string,
): Promise<void> {
  const [busy] = await getDb()
    .select({ id: backupRunsTable.id })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.targetId, targetId),
        eq(backupRunsTable.status, "running"),
        gt(
          backupRunsTable.startedAt,
          new Date(Date.now() - BACKUP_RUN_MAX_MS).toISOString(),
        ),
      ),
    )
    .limit(1);
  if (busy)
    throw new Error(
      "A backup of this one is already running. Wait for it to finish, or stop it from the Backups tab.",
    );
}

/**
 * The ONE executor every real backup goes through - a schedule's "Run now"
 * (`runBackup`), an ad-hoc project run (`runAppBackup`), and (Step 6) the
 * scheduler.
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
  const targetKey =
    (opts.kind === "database" ? opts.databaseId : opts.appId) ?? "";
  if (targetKey) await assertNotAlreadyBackingUp(teamId, targetKey);
  // The target id is known up front (it IS the database/project id), so the run
  // record can be appended BEFORE the expensive resolution (descriptor build, which
  // for a project dials the agent).
  const run: BackupRun = {
    id: runId,
    teamId,
    backupId: opts.backupId,
    targetKind: opts.kind,
    databaseId: opts.kind === "database" ? opts.databaseId : null,
    appId: opts.kind === "app" ? opts.appId : null,
    destinationId: opts.destinationId,
    // Denormalized on purpose: the two FK columns above are ON DELETE SET NULL, so
    // deleting the app or database blanks them and nothing is left naming what the
    // artifact on disk belonged to.
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
  // START transaction (short): persist the `running` run + stamp the owning schedule.
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
  let activityDatabaseId: string | null =
    opts.kind === "database" ? opts.databaseId : null;
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
  let creds: Awaited<
    ReturnType<typeof getDestinationWithSecretsForTeam>
  > | null = null;
  try {
    creds = await getDestinationWithSecretsForTeam(teamId, opts.destinationId);
    const target = await resolveTarget(
      teamId,
      opts.kind,
      opts.databaseId,
      opts.appId,
    );
    label = target.label;
    activityAppId = target.appId;
    activityDatabaseId = target.databaseId;
    targetServerId = target.serverId;
    objectKey = buildObjectKey({
      teamId,
      kind: opts.kind,
      targetId: target.targetId,
      runId,
      // A store artifact is age-encrypted, so its name says so - the `.age` a
      // user would need to know to decrypt it by hand with the recovery key.
      ext: artifactExt(
        opts.kind,
        target.dbType,
        Boolean(creds.destination.ageRecipient),
      ),
      at: new Date(startedAt),
    });
    // Record the resolved key on the running record now, so a crash mid-dump
    // leaves the (single) object's key behind for a sweep. A single UPDATE -
    // outside any transaction (the agent dump follows immediately).
    await getDb()
      .update(backupRunsTable)
      .set({ objectKey })
      .where(eq(backupRunsTable.id, runId));

    // WHERE the bytes go - an S3 bucket, this host's disk, or another server's
    // via the control-plane relay - is entirely backup-transport's problem.
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
    if (!result.ok)
      failure = result.error || "the agent reported a failed backup";

    // Retention runs on success only (a failed run wrote no object). Best-effort: a
    // prune failure must never fail the backup the operator asked for.
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
  // schedule.
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
      .where(
        and(
          eq(backupRunsTable.id, runId),
          eq(backupRunsTable.status, "running"),
        ),
      )
      .returning();
    // The record can be gone (deleting a target sweeps its run history, and a backup
    // can be in flight when that happens) or no longer `running` (it was canceled).
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
        .set({
          lastRunAt: finishedAt,
          lastStatus: failure ? "failed" : "success",
        })
        .where(eq(backupsTable.id, opts.backupId));
    }
    return assembleBackupRun(updated[0]!);
  });

  // The cancel already said what happened, in its own Activity entry and to the
  // person who pressed the button.
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
    null,
    activityDatabaseId,
  );
  // executeBackup already takes teamId as a parameter, so the scheduler tick,
  // which has no request and no active team - alerts exactly like a manual run.
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
 * its leftover run RECORDS down to the cap. A run record is dropped ONLY when its
 * object is gone - actually deleted, or it never owned one (a failed run).
 */
async function pruneRetention(
  teamId: string,
  target: ResolvedTarget,
  destinationId: string,
  keepLast: number,
): Promise<void> {
  // Candidates carry their `seq` (the bigint identity) so `selectDoomedRuns` ranks
  // newest-first by `(startedAt, seq)` - a same-millisecond tie ordered by
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
    // itself, otherwise the cap would delete the very artifacts it was asked to
    // keep, and the record it needs to find them by.
    maxRecords: Math.max(MAX_RUNS_PER_TARGET, keepLast),
  });
  if (doomed.length === 0) return;

  // A failed run owns no object - its record can always be dropped. A successful
  // run's record is dropped only once its object is confirmed gone.
  const removable = new Set(
    doomed
      .filter((r) => r.status !== "success" || !r.objectKey)
      .map((r) => r.id),
  );
  const toDelete = doomed.filter((r) => r.status === "success" && r.objectKey);
  if (toDelete.length) {
    const creds = await getDestinationWithSecretsForTeam(teamId, destinationId);
    try {
      // Routed by DESTINATION, not by target: an artifact on another server's disk is
      // only reachable through THAT server's agent, and dialing the workload's host
      // instead would answer "no such file" forever - leaking the artifact while the
      // record quietly disappeared.
      const results = await deleteManyFromDestination(
        creds,
        target.serverId,
        toDelete.map((r) => ({ key: r.objectKey })),
      );
      results.forEach((res, i) => {
        const r = toDelete[i]!;
        // The agent resolves `ok:false` (not a throw) on a destination-side failure, so
        // gate on `ok` - only a confirmed delete (incl. idempotent already-gone) retires
        // the record.
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
 * Gate a backup operation on its TARGET.
 */
async function requireBackupCapability(
  target: { targetKind: BackupTargetKind; appId: string | null },
  cap: "manage_backups" | "restore_backups" | "delete_backups",
): Promise<void> {
  if (target.targetKind === "app" && target.appId) {
    await requireAppCapability(target.appId, cap);
    return;
  }
  // A database belongs to no Project, so a principal who reaches only part of the
  // team reaches none of them, and all three capabilities here survive the clamp
  // (they mean something on an app), so the team-wide `requireCapability` below would
  // let one through.
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
 * Run a backup SCHEDULE unattended (Step 6 scheduler) - the session-free twin of
 * {@link runBackup}.
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
 * Ad-hoc "Back up now" - one run with no owning schedule, sharing the executor
 * with `backupId: null`.
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
    if (!(await loadTeamApp(targetId, teamId)))
      throw new Error("App not found");
  } else if (
    // A principal who reaches only part of the team can't see any database, so
    // they can't dump one either - the same answer their own reads give.
    !(await reachesWholeTeam()) ||
    !(await databaseFor(targetId, teamId))
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
 * Stream one backup artifact out, decrypted, for the download route. The caller
 * MUST call `close()` once the response is finished - the agent connection stays
 * open behind it.
 */
export async function downloadBackupArtifact(runId: string): Promise<{
  filename: string;
  /**
   * The exact number of bytes the stream below will produce, or null when the run
   * never recorded it (taken before the agent reported it). Advertising it would
   * leave the browser waiting for bytes that never come.
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
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    )
    .limit(1);
  if (!runRows[0]) throw new Error("Backup run not found");
  const run = assembleBackupRun(runRows[0]);
  if (run.status !== "success")
    throw new Error(
      "This backup did not complete successfully and cannot be downloaded",
    );
  await requireBackupCapability(run, "restore_backups");
  // An app archive carries the app's variables DECRYPTED (its snapshot), so
  // handing the bytes over is a reveal, and takes that capability too.
  if (run.targetKind === "app" && run.appId)
    await requireAppCapability(run.appId, "reveal_secrets");

  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    run.destinationId,
  );
  const target = await downloadTargetFor(run, teamId);
  const label = target.label;

  // The destination decides WHICH agent fetches it: its own host for a store, the
  // workload's for a bucket.
  const via =
    destinationServerId(creds.destination, target.serverId ?? "") ||
    (await anyBackupCapableServer());
  if (!via)
    throw new Error(
      "No server on this instance can reach the destination this backup is kept in",
    );
  const opened = await openArtifactDownload(
    creds,
    via,
    run.objectKey,
    run.sha256 ?? "",
  );

  // Recorded HERE, when the stream opens, not when it finishes, and worded for that
  // instant.
  await recordActivity(
    "backup",
    `Started downloading a backup of ${label}`,
    user.name,
    run.appId,
    teamId,
    null,
    run.databaseId,
  );
  return {
    filename: downloadFilename(label, run),
    sizeBytes: run.decryptedSizeBytes,
    ...opened,
  };
}

/**
 * What a download needs to know about the run's target: what to call the file, and
 * which host runs the thing it came from.
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
        and(
          eq(databasesTable.id, run.databaseId),
          eq(databasesTable.teamId, teamId),
        ),
      )
      .limit(1);
    return {
      label: rows[0]?.name ?? "database",
      serverId: rows[0]?.serverId ?? null,
    };
  }
  const app = run.appId ? await loadAppGraph(run.appId) : null;
  return { label: app?.name ?? "app", serverId: app?.serverId ?? null };
}

/**
 * The name the browser saves the artifact under.
 */
function downloadFilename(label: string, run: BackupRun): string {
  const slug =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "backup";
  const stamp = run.startedAt.replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");
  const ext = run.objectKey
    .replace(/^.*?\.(?=[a-z])/, "")
    .replace(/\.age$/, "");
  return `${slug}-${stamp}.${ext || "gz"}`;
}

/**
 * Restore a backup IN PLACE from one of its recorded runs.
 */
export async function restoreBackup(runId: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    )
    .limit(1);
  if (!runRows[0]) throw new Error("Backup run not found");
  const run = assembleBackupRun(runRows[0]);
  if (run.status !== "success")
    throw new Error(
      "This backup did not complete successfully and cannot be restored",
    );
  // Restore is destructive (stop → wipe → untar), so it is gated exactly like the
  // backup it replays - on the run's own target.
  await requireBackupCapability(run, "restore_backups");

  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    run.destinationId,
  );
  let failure: string | null = null;
  // A restore is stop → wipe → untar → reroute, so it must not interleave with a
  // deploy, a delete, a transfer or a second restore of the same app: those all
  // hold `app-lifecycle:<appId>` (see `deleteApp` and the deploy pipeline). The
  // target is resolved UNDER the lock, so a transfer that commits first is seen.
  const withLifecycleLock = async <T>(fn: () => Promise<T>): Promise<T> =>
    run.targetKind === "app" && run.appId
      ? withKeyedLock(`app-lifecycle:${run.appId}`, fn)
      : fn();
  let target!: Awaited<ReturnType<typeof resolveTarget>>;
  await withLifecycleLock(async () => {
    target = await resolveTarget(
      teamId,
      run.targetKind,
      run.databaseId,
      run.appId,
    );
    try {
      // Say what is happening BEFORE it starts.
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
        // skips the check - see the warning the caller surfaces for those.
        run.sha256 ?? "",
      );
      if (!result.ok)
        failure = result.error || "the agent reported a failed restore";
    } catch (e) {
      failure = (mapBackupUnsupported(e) as Error).message;
    } finally {
      // The agent's app restore ends in a Reroute, so a clean run leaves the stack up.
      if (run.targetKind === "app" && target.appId)
        await setAppStatus(target.appId, failure ? "error" : "active");
    }
  });

  // The agent's restore ends on the network the ARCHIVE names: it prefers the
  // archived compose once the digest proves it, and writes that YAML verbatim. So
  // re-render, and OUTSIDE the lifecycle lock - `rerouteApp` takes the same one.
  if (!failure && run.targetKind === "app" && target.appId) {
    const { rerouteApp } = await import("../deploy/build");
    await rerouteApp(target.appId).catch((e) => {
      console.warn(
        `[deplo] ${target.appId} was restored but could not be put back on its network: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    });
  }

  await recordActivity(
    "backup",
    failure
      ? `Restore of ${target.label} failed: ${failure}`
      : `Restored ${target.label} from a backup`,
    user.name,
    target.appId,
    teamId,
    null,
    target.databaseId,
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
 * Targets with an upload restore streaming into them right now. Two at once would
 * untar into the same volumes while the other wipes them. The second caller is
 * refused, not queued - it is holding a file open in a browser.
 */
const uploadRestoresInFlight = new Set<string>();

/**
 * The dumps this process is driving, by run id, so "Stop" can reach one halfway
 * through a 25 GB tar: aborting the controller cancels the gRPC stream the agent's
 * write loop checks, so the work stops ON THE HOST. In-memory, single process; a
 * run this process does not hold is still marked canceled, then swept.
 */
const backupRunsInFlight = new Map<string, AbortController>();

/**
 * Restore an app or a database from an artifact the operator UPLOADS - the only
 * recovery path that survives losing the control plane. Everything that can
 * refuse refuses BEFORE the agent is dialed, and the bytes never touch a disk.
 * `abandon()` is the same cleanup for a stream nobody pulled (no `finally` runs).
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
  await requireBackupCapability(
    { targetKind: input.kind, appId },
    "restore_backups",
  );

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
    // The artifact is judged FIRST, before the target is even resolved: for an app that
    // resolution already dials the owning agent (the descriptor carries the live
    // stack), and a file that was never a backup should cost nobody a round trip, let
    // alone reach a host.
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

    opened = await openUploadRestore(
      target,
      wrapped.ageIdentity,
      wrapped.chunks,
    );
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
      null,
      resolved.databaseId,
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
              failure =
                ev.result.error || "the agent reported a failed restore";
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
 * Why an UPLOADED artifact must not be restored into this target, or null. NOT
 * the security boundary (that is the `untrusted_config` flag): an app never
 * deployed on its host has no stack for the data to land in, and its descriptor's
 * empty compose is the test for that.
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
 * The keypair lives for this request only - the shape RestoreFrom insists on, not
 * a secret to keep. Pull-based, so one chunk is held whatever the file's size.
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
  if (
    !(await backupTargetInScope(
      filter.appId ? "app" : "database",
      filter.appId ?? filter.databaseId ?? "",
    ))
  )
    return [];
  // Exactly one of appId/databaseId selects the target; neither ⇒ no runs.
  const targetWhere = filter.appId
    ? eq(backupRunsTable.appId, filter.appId)
    : filter.databaseId
      ? eq(backupRunsTable.databaseId, filter.databaseId)
      : null;
  if (!targetWhere) return [];
  // Newest-first by (started_at, seq) DESC, pushed into SQL (matches
  // backup_runs_team_started_idx) - deterministic under a same-ms tie (PLAN §5).
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(and(eq(backupRunsTable.teamId, teamId), targetWhere))
    .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq));
  return rows.map(assembleBackupRun);
}

/** What backs a database up, for the one card the overview shows. */
export interface DatabaseBackupSummary {
  /** This database's schedules, newest first. Empty ⇒ nothing backs it up. */
  schedules: Backup[];
  /** The newest run of ANY kind, scheduled or ad-hoc. */
  lastRunAt: string | null;
  lastStatus: BackupRunStatus | null;
}

/**
 * A database's backup state in one read. The runs query is not redundant with
 * `Backup.lastRunAt`, which only tracks SCHEDULED runs: an ad-hoc run carries
 * `backupId: null`, so schedules alone still say "Never run" right after one.
 */
export async function getDatabaseBackupSummary(
  databaseId: string,
): Promise<DatabaseBackupSummary> {
  const empty: DatabaseBackupSummary = {
    schedules: [],
    lastRunAt: null,
    lastStatus: null,
  };
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope("database", databaseId))) return empty;

  const db = getDb();
  const [scheduleRows, runRows] = await Promise.all([
    // assembleBackup, not toDTO: the DTO resolves an app graph, a database and a
    // destination name PER ROW, and this runs on the most-visited database page.
    db
      .select()
      .from(backupsTable)
      .where(
        and(
          eq(backupsTable.teamId, teamId),
          eq(backupsTable.databaseId, databaseId),
        ),
      )
      .orderBy(desc(backupsTable.createdAt)),
    db
      .select()
      .from(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.teamId, teamId),
          eq(backupRunsTable.databaseId, databaseId),
        ),
      )
      .orderBy(desc(backupRunsTable.startedAt), desc(backupRunsTable.seq))
      .limit(1),
  ]);

  const last = runRows[0];
  return {
    schedules: scheduleRows.map(assembleBackup),
    lastRunAt: last?.startedAt ?? null,
    lastStatus: (last?.status as BackupRunStatus | undefined) ?? null,
  };
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
 * Edit a schedule's settings: name, destination, cron and retention. The target
 * binding is fixed at creation - pointing a schedule elsewhere is a different
 * schedule. The scheduler re-reads every tick, so a new cron needs no re-register.
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
    b.appId,
    teamId,
    null,
    b.databaseId,
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
 * Stop a running backup. The ORDER is the point: the record is flipped first as a
 * compare-and-swap on `running`, so the dump finishing a second later cannot undo
 * it; then the stream is aborted, so the tar stops on the host. Gated on
 * `manage_backups` - stopping a dump you are allowed to start is the same power.
 */
export async function cancelBackupRun(runId: string): Promise<boolean> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    )
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
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.status, "running")),
    )
    .returning({ id: backupRunsTable.id });
  if (stopped.length === 0) return false;

  // The schedule stops reading "Running" at once, rather than waiting out
  // whatever the abort below takes to unwind.
  if (run.backupId)
    await getDb()
      .update(backupsTable)
      .set({ lastStatus: "canceled" })
      .where(
        and(eq(backupsTable.id, run.backupId), eq(backupsTable.teamId, teamId)),
      );

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
    null,
    run.databaseId,
  );
  return true;
}

/**
 * Delete ONE backup, artifact and record together - the only way to retire a
 * single restore point. `delete_backups`, its own capability: it is the one verb
 * here with no way back. Artifact FIRST, record second, or the object outlives
 * everything that could name it. A `running` run is refused, not deleted.
 */
export async function deleteBackupRun(runId: string): Promise<void> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;

  const runRows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    )
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
    const creds = await getDestinationWithSecretsForTeam(
      teamId,
      run.destinationId,
    );
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
    .where(
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.teamId, teamId)),
    );

  await recordActivity(
    "backup",
    `Deleted a backup of ${target.label} from ${formatBytes(run.sizeBytes)}`,
    user.name,
    run.appId,
    teamId,
    null,
    run.databaseId,
  );
}

/**
 * Delete a target's artifacts in ONE destination. BY EXACT KEY, never by prefix:
 * two `server` destinations on one host resolve to the SAME managed folder, so a
 * prefix sweep deleted the other's artifacts and kept its records. The keys come
 * from `backup_runs`; a failed delete keeps its row so the next attempt finds it.
 */
export async function deleteBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  serverId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  // Destructive, and gated on the view floor alone, so the scope check has to
  // be here: a caller-supplied targetId must be one this request can reach.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    input.destinationId,
  );

  // Every run this target has in this destination. A `running` one is in flight
  // and owns no committed artifact yet; a failed one owns none at all.
  const runs = await getDb()
    .select({
      id: backupRunsTable.id,
      objectKey: backupRunsTable.objectKey,
      status: backupRunsTable.status,
    })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, input.destinationId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  const withArtifacts = runs.filter(
    (r) => r.status === "success" && r.objectKey,
  );

  // The deletes (RPC) run BEFORE the record delete - outside any tx.
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

  // Drop the run records for THIS target in THIS destination; other destinations
  // stay. EXCEPT a `running` one: its file does not exist yet, so dropping the row
  // means the dump lands an artifact nothing anywhere can name.
  const removable = runs.filter((r) => r.status !== "running").map((r) => r.id);
  if (removable.length > 0)
    await getDb()
      .delete(backupRunsTable)
      .where(inArray(backupRunsTable.id, removable));
  return deleted;
}

/**
 * The `backup_runs` WHERE clause selecting one target. On `target_id`, NOT on the
 * `database_id`/`app_id` FKs: those are ON DELETE SET NULL, so a deleted target's
 * runs stopped matching and their artifacts sat there with nothing to name them.
 */
function runTargetWhere(kind: BackupTargetKind, targetId: string) {
  return and(
    eq(backupRunsTable.targetKind, kind),
    eq(backupRunsTable.targetId, targetId),
  )!;
}

/**
 * How many stored artifacts a target still has - one per SUCCESSFUL run.
 * Team-scoped. Drives the delete dialog's "also delete backup artifacts", hidden
 * at 0: offering a sweep with nothing to sweep also fired an invalid-value error.
 */
export async function countBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId))) return 0;
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
 * The distinct destinations a target has runs in, so a "delete artifacts too"
 * caller can sweep EVERY one (calling {@link deleteBackupArtifacts} once per
 * destination) rather than just the one a single schedule used. Team-scoped.
 */
export async function backupDestinationsForTarget(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<string[]> {
  const teamId = await requireActiveTeamId();
  if (!(await backupTargetInScope(input.kind, input.targetId))) return [];
  const rows = await getDb()
    .selectDistinct({ destinationId: backupRunsTable.destinationId })
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  return rows.map((r) => r.destinationId);
}

/**
 * Wipe EVERY artifact of one target across all its destinations. The capability
 * mirrors the target's OWN delete gate (`delete_databases` / `delete_apps`), and
 * it runs BEFORE the row goes so it still resolves its server. A partial failure
 * is returned, not swallowed: the resolver throws and the delete aborts.
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
      : // `delete_databases`, matching `deleteDatabase`, NOT `manage_backups`.
        // This wipes every restore point a database has, with no undo, and
        // `manage_backups` says "create, edit, disable and run backup schedules"
        // and is handed out on that reading. Whoever may destroy the database may
        // destroy its backups; nobody else.
        await requireCapability("delete_databases");
  // `manage_backups` survives the project clamp, so the database branch above
  // would otherwise let a narrowed token wipe a target it can't reach. Mirrors
  // the check in {@link deleteBackupArtifacts}.
  if (!(await backupTargetInScope(input.kind, input.targetId)))
    throw new Error("Not found");
  // Resolve the owning server straight off the target row, no agent round-trip
  // (a project's full descriptor needs `readStack`, which we don't need just to
  // delete objects). A missing/foreign row yields no server and nothing to do.
  const serverId =
    input.kind === "database"
      ? ((await databaseServerId(input.targetId, teamId)) ?? null)
      : ((await loadTeamApp(input.targetId, teamId))?.serverId ?? null);

  const destinations = await backupDestinationsForTarget(input);
  if (destinations.length === 0) return { deleted: 0, failedDestinations: [] };
  if (!serverId) {
    // The target row is gone (or never ours) yet run records linger - there is no
    // owning agent left to reach the buckets.
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
 * reclaims their disk. "Keep" used to mean "keep forever, invisibly" - nothing
 * listed them and retention could not see them. A month covers the regret.
 */
const ORPHAN_ARTIFACT_KEEP_MS = 30 * 24 * 60 * 60_000;

/**
 * Any provisioned server whose agent can reach a BUCKET. In a sweep the workload
 * whose agent would normally be used is exactly what no longer exists, and any
 * backup-capable agent can talk to a bucket. Raw query: no session on a tick.
 */
async function anyBackupCapableServer(): Promise<string | null> {
  const rows = await getDb()
    .select({ id: serversTable.id })
    .from(serversTable)
    .where(
      and(
        isNotNull(serversTable.agentCertFingerprint),
        // Never a migration source: it is the other platform's machine, borrowed
        // for one import. Relaying our backup traffic through it would be using
        // infrastructure that is not ours for something it never agreed to.
        eq(serversTable.importOnly, false),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * How many artifacts one sweep will try to remove. It runs daily and is
 * idempotent, so a backlog simply drains over a few days, and the cap is what
 * keeps a first sweep on a long-lived instance from holding the scheduler's
 * lease through thousands of agent round trips.
 */
const ORPHAN_SWEEP_BATCH = 500;

/**
 * Reclaim the artifacts of targets that no longer exist - runs left pointing at
 * nothing by an ON DELETE SET NULL, and only those. TWO PASSES: a run is STAMPED
 * when first seen orphaned and acted on only once the stamp is old, or an app
 * deleted today with old backups would lose them the same day. Idempotent.
 */
export async function sweepOrphanedBackupArtifacts(): Promise<number> {
  const orphanedTargets = and(
    isNull(backupRunsTable.appId),
    isNull(backupRunsTable.databaseId),
  );

  // PASS 1 - start the clock on anything newly orphaned. Nothing is deleted on
  // the tick that first notices a target is gone.
  await getDb()
    .update(backupRunsTable)
    .set({ orphanedAt: nowIso() })
    .where(and(orphanedTargets, isNull(backupRunsTable.orphanedAt)));

  // PASS 2 - act on the ones that have been orphaned long enough.
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
      runs
        .filter((r) => r.status !== "success" || !r.objectKey)
        .map((r) => r.id),
    );
    const withArtifacts = runs.filter(
      (r) => r.status === "success" && r.objectKey,
    );
    if (withArtifacts.length > 0) {
      try {
        const creds = await getDestinationWithSecretsForTeam(
          teamId,
          destinationId,
        );
        const via =
          creds.destination.serverId ?? (await anyBackupCapableServer());
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
    console.log(
      `[deplo] reclaimed ${reclaimed} backup artifact(s) of deleted targets`,
    );
  return reclaimed;
}

/**
 * The longest a real backup could still be running before a `running` record is
 * called orphaned. DERIVED from the agent RPC's own deadline plus slack, not
 * picked beside it: two independent numbers disagreed and declared a live run dead.
 */
const RUN_ORPHAN_AFTER_MS = BACKUP_RUN_MAX_MS;

/**
 * Reconcile backup runs orphaned by a control-plane restart - the analogue of
 * `reconcileInFlightDeployments`. A run is persisted `running` before the dump, so
 * a death in between sticks it there forever and retention never prunes it. Only
 * touches runs older than {@link RUN_ORPHAN_AFTER_MS}, so it cannot race a live one.
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
      ...new Set(
        flipped.map((r) => r.backupId).filter((id): id is string => !!id),
      ),
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
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(n) / Math.log(1024)),
  );
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
