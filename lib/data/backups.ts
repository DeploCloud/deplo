import "server-only";

import { and, count, desc, eq, inArray, lt } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
  databases as databasesTable,
  s3Destination as s3DestinationTable,
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
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { requireFolderCapabilityForApp } from "./folder-access";
import { loadAppGraph, loadTeamApp } from "./app-graph-load";
import { decryptSecret } from "../crypto";
import { parseConnectionPassword } from "../deploy/database-compose";
import {
  connectBackupAgent,
  mapBackupUnsupported,
} from "../infra/agent-client";
import { getS3WithSecretsForTeam, s3TargetFor } from "./s3";
import {
  buildProjectDescriptor,
  type ProjectBackupDescriptor,
} from "./project-backup-descriptor";
import {
  artifactExt,
  buildObjectKey,
  targetPrefix,
  selectDoomedRuns,
  type RunForRetention,
} from "./backup-objectkey";
import { BackupKind } from "../agent/gen/agent";
import type {
  BackupRequest,
  RestoreRequest,
  DatabaseDescriptor,
  ProjectDescriptor,
} from "../agent/gen/agent";
import type {
  Backup,
  BackupRun,
  BackupTargetKind,
  Database,
  DatabaseType,
} from "../types";

/** Newest run plus a cap on how many runs we keep per target (alongside the
 *  age-based `retentionDays`). Bounds the JSONB `backupRuns` array + the bucket. */
const MAX_RUNS_PER_TARGET = 50;

export interface BackupDTO extends Backup {
  databaseName: string | null;
  serviceName: string | null;
  destinationName: string;
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

/** Whether a team owns the S3 destination `id`. */
async function destinationExists(id: string, teamId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: s3DestinationTable.id })
    .from(s3DestinationTable)
    .where(and(eq(s3DestinationTable.id, id), eq(s3DestinationTable.teamId, teamId)))
    .limit(1);
  return rows.length > 0;
}

/** Resolve the display name of an S3 destination by id (team-scoped), or "". */
async function destinationNameFor(id: string, teamId: string): Promise<string> {
  const rows = await getDb()
    .select({ name: s3DestinationTable.name })
    .from(s3DestinationTable)
    .where(and(eq(s3DestinationTable.id, id), eq(s3DestinationTable.teamId, teamId)))
    .limit(1);
  return rows[0]?.name ?? "";
}

async function toDTO(b: Backup): Promise<BackupDTO> {
  // Every related collection is relational now: the database/destination names by
  // point lookup, the project name via the project graph (cut-set c).
  const serviceName = b.appId
    ? ((await loadAppGraph(b.appId))?.name ?? null)
    : null;
  return {
    ...b,
    databaseName: await databaseNameFor(b.databaseId, b.teamId),
    serviceName,
    destinationName: await destinationNameFor(b.destinationId, b.teamId),
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
  return Promise.all(rows.map((r) => toDTO(assembleBackup(r))));
}

export async function createBackup(input: {
  name: string;
  targetKind?: BackupTargetKind;
  databaseId: string | null;
  appId?: string | null;
  destinationId: string;
  schedule: string;
  retentionDays: number;
}): Promise<BackupDTO> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");

  const targetKind: BackupTargetKind = input.targetKind ?? "database";
  const appId = input.appId ?? null;
  const databaseId = input.databaseId ?? null;

  // The chosen destination + the target (database OR project) must belong to this
  // team. Exactly one target is set, matching `targetKind`.
  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");
  if (targetKind === "database") {
    if (!databaseId) throw new Error("Select a database to back up");
    if (!(await databaseNameFor(databaseId, teamId)))
      throw new Error("Database not found");
  } else {
    if (!appId) throw new Error("Select a project to back up");
    if (!(await loadTeamApp(appId, teamId)))
      throw new Error("App not found");
    // Folder-scope: backing up a project inside a folder needs manage_infra on
    // that folder too, not just at the team level.
    await requireFolderCapabilityForApp(appId, "manage_infra");
  }

  const b: Backup = {
    id: newId("bkp"),
    teamId,
    name: input.name.trim(),
    targetKind,
    databaseId: targetKind === "database" ? databaseId : null,
    appId: targetKind === "app" ? appId : null,
    destinationId: input.destinationId,
    schedule: input.schedule || "0 3 * * *",
    retentionDays: Math.max(1, input.retentionDays || 7),
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
    retentionDays: number;
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
    objectKey: "", // filled once the key is built (after resolution)
    sizeBytes: 0,
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
  let result: { ok: boolean; error: string; objectKey: string; sizeBytes: number } | null = null;
  let failure: string | null = null;
  let objectKey = "";
  try {
    const creds = await getS3WithSecretsForTeam(teamId, opts.destinationId);
    const target = await resolveTarget(teamId, opts.kind, opts.databaseId, opts.appId);
    label = target.label;
    activityAppId = target.appId;
    objectKey = buildObjectKey({
      teamId,
      kind: opts.kind,
      targetId: target.targetId,
      runId,
      ext: artifactExt(opts.kind, target.dbType),
      at: new Date(startedAt),
    });
    // Record the resolved key on the running record now, so a crash mid-dump
    // leaves the (single) object's key behind for a sweep. A single UPDATE —
    // outside any transaction (the agent dump follows immediately).
    await getDb()
      .update(backupRunsTable)
      .set({ objectKey })
      .where(eq(backupRunsTable.id, runId));

    const req: BackupRequest = {
      kind: opts.kind === "database" ? BackupKind.BACKUP_KIND_DATABASE : BackupKind.BACKUP_KIND_PROJECT,
      s3: s3TargetFor(creds, objectKey),
      database: target.database,
      project: target.project,
    };
    const conn = await connectBackupAgent(target.serverId);
    try {
      for await (const ev of conn.backup(req)) {
        if (ev.result) {
          result = {
            ok: ev.result.ok,
            error: ev.result.error,
            objectKey: ev.result.objectKey || objectKey,
            sizeBytes: Number(ev.result.sizeBytes ?? 0),
          };
        }
      }
    } finally {
      conn.close();
    }
    if (!result) failure = "the agent ended the backup without a result";
    else if (!result.ok) failure = result.error || "the agent reported a failed backup";

    // Retention runs on success only (a failed run wrote no object). Best-effort:
    // a prune failure must never fail the backup the operator asked for.
    // An AD-HOC run (no owning schedule) enforces NO age-based retention — its
    // `retentionDays` is a fabricated default, and pruning by it would delete
    // artifacts of schedules with longer retention on the same
    // target+destination. Infinity disables the age cutoff; the
    // MAX_RUNS_PER_TARGET cap still applies.
    if (!failure) {
      try {
        await pruneRetention(
          teamId,
          target,
          creds.destination.id,
          opts.backupId ? opts.retentionDays : Number.POSITIVE_INFINITY,
        );
      } catch (e) {
        console.warn(
          `[backups] retention prune failed for ${target.label}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  } catch (e) {
    failure = (mapBackupUnsupported(e) as Error).message;
  }

  const finishedAt = nowIso();
  // TERMINAL transaction (short): flip the run to its final status + stamp the
  // schedule. The SECOND of the two short transactions; the agent dump completed
  // above, outside any tx (PLAN §1 rule (a)).
  const finished = await getDb().transaction(async (tx): Promise<BackupRun> => {
    const set = failure
      ? { status: "failed" as const, error: failure, finishedAt }
      : {
          status: "success" as const,
          error: null,
          objectKey: result!.objectKey,
          sizeBytes: result!.sizeBytes,
          finishedAt,
        };
    const updated = await tx
      .update(backupRunsTable)
      .set(set)
      .where(eq(backupRunsTable.id, runId))
      .returning();
    if (opts.backupId) {
      await tx
        .update(backupsTable)
        .set({ lastRunAt: finishedAt, lastStatus: failure ? "failed" : "success" })
        .where(eq(backupsTable.id, opts.backupId));
    }
    return assembleBackupRun(updated[0]!);
  });

  await recordActivity(
    "backup",
    failure
      ? `Backup of ${label} failed: ${failure}`
      : `Backed up ${label} (${formatBytes(finished.sizeBytes)})`,
    actor,
    activityAppId,
    teamId,
  );

  if (failure) throw new Error(failure);
  return finished;
}

/**
 * Prune a target's run history + S3 artifacts past the age limit AND the per-
 * target count cap. We delete the OLD objects individually (`s3Delete` by exact
 * key) rather than the whole prefix, so a still-current artifact is never caught.
 * A `running` run is left alone (it's in flight). Only successful runs own an
 * object worth deleting.
 *
 * SCOPED TO ONE DESTINATION: a target can have runs in more than one bucket (an
 * ad-hoc run to a different destination, a re-pointed schedule), and we only hold
 * THIS destination's creds here. Pruning across destinations would compute the
 * "newest success to keep" against the wrong set AND drop the OTHER bucket's run
 * records while their objects survive (an orphan + a vanished restore point). So
 * we consider only runs that live in `destinationId`.
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
  retentionDays: number,
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
    retentionDays,
    maxPerTarget: MAX_RUNS_PER_TARGET,
    now: new Date(),
  });
  if (doomed.length === 0) return;

  // A failed run owns no object — its record can always be dropped. A successful
  // run's record is dropped only once its object is confirmed gone.
  const removable = new Set(
    doomed.filter((r) => r.status !== "success" || !r.objectKey).map((r) => r.id),
  );
  const toDelete = doomed.filter((r) => r.status === "success" && r.objectKey);
  if (toDelete.length) {
    const creds = await getS3WithSecretsForTeam(teamId, destinationId);
    const conn = await connectBackupAgent(target.serverId);
    try {
      for (const r of toDelete) {
        try {
          const res = await conn.s3Delete(s3TargetFor(creds, r.objectKey));
          // The agent resolves `ok:false` (not a throw) on an S3-side failure, so
          // gate on `ok` — only a confirmed delete (incl. idempotent already-gone)
          // retires the record. A transient failure keeps it for the next prune.
          if (res.ok) removable.add(r.id);
          else
            console.warn(
              `[backups] could not delete artifact ${r.objectKey}: ${res.error || "agent reported failure"} (will retry next prune)`,
            );
        } catch (e) {
          console.warn(
            `[backups] could not delete artifact ${r.objectKey}: ${e instanceof Error ? e.message : String(e)} (will retry next prune)`,
          );
        }
      }
    } finally {
      conn.close();
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
        eq(backupRunsTable.targetKind, kind),
        kind === "database"
          ? eq(backupRunsTable.databaseId, targetId ?? "")
          : eq(backupRunsTable.appId, targetId ?? ""),
      ),
    );
  return rows.map((r) => ({ ...assembleBackupRun(r), seq: r.seq }));
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/** Run a backup SCHEDULE now (manual "Run now"). Real dump + upload + history. */
export async function runBackup(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  // A project-target schedule additionally requires folder access to its project.
  if (b.targetKind === "app" && b.appId)
    await requireFolderCapabilityForApp(b.appId, "manage_infra");
  await executeBackup(teamId, user.name, {
    backupId: b.id,
    kind: b.targetKind,
    databaseId: b.databaseId,
    appId: b.appId,
    destinationId: b.destinationId,
    retentionDays: b.retentionDays,
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
      retentionDays: backup.retentionDays,
    });
  } catch {
    // executeBackup already recorded the run `failed` + logged the activity; the
    // re-thrown error is for the interactive callers, not the scheduler.
  }
}

/**
 * Ad-hoc "Back up now" for a project with no owning schedule — shares the
 * executor with `backupId: null`. Used by the project Backups tab (Step 5).
 * With no schedule to read a policy from, the executor skips the age-based
 * prune for ad-hoc runs (only the MAX_RUNS_PER_TARGET cap applies), so
 * `retentionDays` is carried for the opts shape but never enforced.
 */
export async function runAppBackup(
  appId: string,
  destinationId: string,
  retentionDays = 7,
): Promise<BackupRun> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!(await loadTeamApp(appId, teamId)))
    throw new Error("App not found");
  // Folder-scope the ad-hoc project backup, matching the scheduled path.
  await requireFolderCapabilityForApp(appId, "manage_infra");
  if (!(await destinationExists(destinationId, teamId)))
    throw new Error("Select a destination");
  return executeBackup(teamId, user.name, {
    backupId: null,
    kind: "app",
    databaseId: null,
    appId,
    destinationId,
    retentionDays,
  });
}

/**
 * Restore a backup IN PLACE from one of its recorded runs. Loads the
 * `BackupRun`, decrypts the destination creds, resolves the owning server, and
 * streams the agent's `Restore` to completion (DB = drop-and-recreate; project =
 * stop → wipe + untar → re-Reroute the snapshot). Guarded by `manage_infra`; the
 * UI adds a typed confirmation (Step 5). Throws on a failed restore.
 */
export async function restoreBackup(runId: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
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
  // Restoring INTO a project inside a folder needs manage_infra on that folder —
  // restore is destructive (stop → wipe → untar), so it's gated like the backup.
  if (run.targetKind === "app" && run.appId)
    await requireFolderCapabilityForApp(run.appId, "manage_infra");

  const creds = await getS3WithSecretsForTeam(teamId, run.destinationId);
  const target = await resolveTarget(
    teamId,
    run.targetKind,
    run.databaseId,
    run.appId,
  );
  const s3 = s3TargetFor(creds, run.objectKey);
  const req: RestoreRequest = {
    kind: run.targetKind === "database" ? BackupKind.BACKUP_KIND_DATABASE : BackupKind.BACKUP_KIND_PROJECT,
    s3,
    database: target.database,
    project: target.project,
  };

  let result: { ok: boolean; error: string } | null = null;
  let failure: string | null = null;
  try {
    const conn = await connectBackupAgent(target.serverId);
    try {
      for await (const ev of conn.restore(req)) {
        if (ev.result) result = { ok: ev.result.ok, error: ev.result.error };
      }
    } finally {
      conn.close();
    }
    if (!result) failure = "the agent ended the restore without a result";
    else if (!result.ok) failure = result.error || "the agent reported a failed restore";
  } catch (e) {
    failure = (mapBackupUnsupported(e) as Error).message;
  }

  await recordActivity(
    "backup",
    failure
      ? `Restore of ${target.label} failed: ${failure}`
      : `Restored ${target.label} from a backup`,
    user.name,
    target.appId,
    teamId,
  );
  if (failure) throw new Error(failure);
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
  const teamId = (await requireCapability("manage_infra")).teamId;
  // Load first so a project-target schedule can be folder-scoped before the write.
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  if (b.targetKind === "app" && b.appId)
    await requireFolderCapabilityForApp(b.appId, "manage_infra");
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
    retentionDays: number;
  },
): Promise<BackupDTO> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  if (!input.name.trim()) throw new Error("Name is required");
  if (!input.destinationId) throw new Error("Select a destination");

  // The (possibly changed) destination must belong to this team.
  if (!(await destinationExists(input.destinationId, teamId)))
    throw new Error("Select a destination");

  // A project-target schedule may only be edited by someone with folder access.
  const cur = await loadBackup(id, teamId);
  if (!cur) throw new Error("Not found");
  if (cur.targetKind === "app" && cur.appId)
    await requireFolderCapabilityForApp(cur.appId, "manage_infra");

  const updated = await getDb()
    .update(backupsTable)
    .set({
      name: input.name.trim(),
      destinationId: input.destinationId,
      schedule: input.schedule || "0 3 * * *",
      retentionDays: Math.max(1, input.retentionDays || 7),
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
  const teamId = (await requireCapability("manage_infra")).teamId;
  // Deleting a project-target schedule requires folder access to its project.
  const b = await loadBackup(id, teamId);
  if (!b) throw new Error("Not found");
  if (b.targetKind === "app" && b.appId)
    await requireFolderCapabilityForApp(b.appId, "manage_infra");
  await getDb()
    .delete(backupsTable)
    .where(and(eq(backupsTable.id, id), eq(backupsTable.teamId, teamId)));
}

/**
 * Delete a target's S3 artifacts in ONE destination (its whole folder) via a
 * single prefix-delete — the "delete artifacts too" branch of DB/project
 * deletion (Step 5). Best-effort + idempotent: returns the count removed, or
 * throws when no backup-capable agent can be reached OR the agent reports the
 * prefix-delete failed. The caller decides whether a failure blocks the
 * target's deletion.
 *
 * SCOPED TO ONE DESTINATION: the prefix-delete only touches `input.destinationId`
 * bucket, so we only drop the run records that live in THAT bucket — records for
 * the same target in another destination (whose objects still exist) are kept, so
 * they neither orphan their objects nor vanish from history. A caller that wants
 * to wipe every bucket calls this once per distinct destination.
 */
export async function deleteBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
  destinationId: string;
  serverId: string;
}): Promise<number> {
  const teamId = await requireActiveTeamId();
  const creds = await getS3WithSecretsForTeam(teamId, input.destinationId);
  const prefix = targetPrefix(teamId, input.kind, input.targetId);

  // The prefix-delete (RPC) runs BEFORE the record delete — outside any tx.
  let deleted = 0;
  const conn = await connectBackupAgent(input.serverId);
  try {
    const res = await conn.s3Delete(s3TargetFor(creds, prefix), true);
    // The agent resolves `ok:false` (not a throw) on an S3-side failure — gate
    // the record delete on it, like pruneRetention: dropping the rows while
    // their objects survive would orphan the bucket AND erase the history that
    // lets a retry find them.
    if (!res.ok)
      throw new Error(res.error || "the agent could not delete the backup artifacts");
    deleted = res.deleted;
  } finally {
    conn.close();
  }

  // Drop the run records for THIS target in THIS destination (the bucket we just
  // swept) — records in other destinations (whose objects survive) stay.
  await getDb()
    .delete(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.teamId, teamId),
        eq(backupRunsTable.destinationId, input.destinationId),
        runTargetWhere(input.kind, input.targetId),
      ),
    );
  return deleted;
}

/** The `backup_runs` WHERE clause selecting one target (database OR project). */
function runTargetWhere(kind: BackupTargetKind, targetId: string) {
  return and(
    eq(backupRunsTable.targetKind, kind),
    kind === "database"
      ? eq(backupRunsTable.databaseId, targetId)
      : eq(backupRunsTable.appId, targetId),
  )!;
}

/**
 * How many stored backup artifacts a single target still has in S3 — one per
 * SUCCESSFUL run (a `failed`/`running` run never wrote an object). Team-scoped;
 * exactly one target selected by kind.
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
 * caller can sweep EVERY bucket (calling {@link deleteBackupArtifacts} once per
 * destination) rather than just the one a single schedule used. Team-scoped.
 */
export async function backupDestinationsForTarget(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<string[]> {
  const teamId = await requireActiveTeamId();
  const rows = await getDb()
    .selectDistinct({ destinationId: backupRunsTable.destinationId })
    .from(backupRunsTable)
    .where(
      and(eq(backupRunsTable.teamId, teamId), runTargetWhere(input.kind, input.targetId)),
    );
  return rows.map((r) => r.destinationId);
}

/**
 * Wipe EVERY S3 artifact of one target across all the destinations it ever ran
 * to — the "also delete backup artifacts" branch of DB/project deletion (Step 5).
 * Sweeps each distinct destination via {@link deleteBackupArtifacts}, performed
 * by the target's OWN owning agent (the host that produced the dumps, so its
 * agent is the natural one to reach S3). Returns the total objects removed plus
 * any destinations whose sweep failed.
 *
 * Capability mirrors the target's OWN delete gate so this can never become a
 * privilege escalation OR an unexpected hard block: a database's artifacts need
 * `manage_infra` (like `deleteDatabase`), a project's need `deploy` (like
 * `deleteApp`). Run BEFORE the target row is deleted, so it still resolves to
 * its owning server.
 *
 * A partial failure is NOT swallowed: the call returns the failing destinations,
 * and the GraphQL resolver throws on a non-empty `failedDestinations` so the
 * delete flow aborts (a half-done "delete with backups" that silently leaves a
 * bucket full is worse than a retryable no-op).
 */
export async function deleteAllBackupArtifacts(input: {
  kind: BackupTargetKind;
  targetId: string;
}): Promise<{ deleted: number; failedDestinations: string[] }> {
  // Gate on the same capability the target's own deletion requires, enforced in
  // the data layer (the real gate) rather than relying on a single static
  // GraphQL authScope that can't vary by kind.
  const { teamId } = await requireCapability(
    input.kind === "database" ? "manage_infra" : "deploy",
  );
  // Folder-scope the project branch like every sibling backup op: wiping a
  // project's artifacts inside a folder needs `deploy` on that folder too.
  // (A no-op for a missing/foreign id — the team-scoped server lookup below
  // stays the authority on existence.)
  if (input.kind === "app")
    await requireFolderCapabilityForApp(input.targetId, "deploy");
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
 * The longest a real backup could still be running before we call a `running`
 * record orphaned: the agent caps each dump/upload step at ~30min, plus generous
 * slack for a volume-heavy project + dial. A `running` run older than this is one
 * whose driving request died (a control-plane restart / crash) — its agent stream
 * is gone, so it will never reach its terminal mutate.
 */
const RUN_ORPHAN_AFTER_MS = 90 * 60_000;

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
      .returning({ backupId: backupRunsTable.backupId });

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
    return flipped.length;
  });
  if (reconciled > 0) {
    console.warn(
      `[deplo] reconciled ${reconciled} interrupted backup run(s) to failed on startup`,
    );
  }
  return reconciled;
}

/** Compact human bytes for the activity log ("12.3 MB"). */
function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
