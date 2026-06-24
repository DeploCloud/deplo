import "server-only";

import { read, mutate } from "../store";
import { getCurrentUser } from "../auth";
import { newId, nowIso } from "../ids";
import { requireActiveTeamId, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { loadProjectGraph, loadTeamProject } from "./project-graph-load";
import { decryptSecret } from "../crypto";
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
  projectName: string | null;
  destinationName: string;
}

async function toDTO(b: Backup): Promise<BackupDTO> {
  const d = read();
  // `databases`/`s3Destinations` stay JSONB (cut-set d); the project NAME is
  // relational now (cut-set c) — look it up via the project graph.
  const projectName = b.projectId
    ? ((await loadProjectGraph(b.projectId))?.name ?? null)
    : null;
  return {
    ...b,
    databaseName: b.databaseId
      ? (d.databases.find((x) => x.id === b.databaseId)?.name ?? null)
      : null,
    projectName,
    destinationName:
      d.s3Destinations.find((x) => x.id === b.destinationId)?.name ?? "",
  };
}

export async function listBackups(): Promise<BackupDTO[]> {
  const teamId = await requireActiveTeamId();
  const rows = read()
    .backups.filter((b) => b.teamId === teamId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return Promise.all(rows.map(toDTO));
}

export async function createBackup(input: {
  name: string;
  targetKind?: BackupTargetKind;
  databaseId: string | null;
  projectId?: string | null;
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
  const projectId = input.projectId ?? null;
  const databaseId = input.databaseId ?? null;

  // The chosen destination + the target (database OR project) must belong to this
  // team. Exactly one target is set, matching `targetKind`.
  const d0 = read();
  if (!d0.s3Destinations.some((x) => x.id === input.destinationId && x.teamId === teamId))
    throw new Error("Select a destination");
  if (targetKind === "database") {
    if (!databaseId) throw new Error("Select a database to back up");
    if (!d0.databases.some((x) => x.id === databaseId && x.teamId === teamId))
      throw new Error("Database not found");
  } else {
    if (!projectId) throw new Error("Select a project to back up");
    if (!d0.projects.some((x) => x.id === projectId && x.teamId === teamId))
      throw new Error("Project not found");
  }

  const b: Backup = {
    id: newId("bkp"),
    teamId,
    name: input.name.trim(),
    targetKind,
    databaseId: targetKind === "database" ? databaseId : null,
    projectId: targetKind === "project" ? projectId : null,
    destinationId: input.destinationId,
    schedule: input.schedule || "0 3 * * *",
    retentionDays: Math.max(1, input.retentionDays || 7),
    lastRunAt: null,
    lastStatus: "never",
    enabled: true,
    createdAt: nowIso(),
  };
  mutate((d) => d.backups.push(b));
  recordActivity(
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
 * The superuser each engine's compose actually creates (database-compose.ts) —
 * this, NOT the connection string's user, is what the dump tool authenticates
 * as. mysql/mariadb only get a ROOT password (MYSQL_ROOT_PASSWORD), so their
 * descriptor user is `root` even though the connection string reads `app`.
 */
const DB_DUMP_USER: Record<DatabaseType, string> = {
  postgres: "app",
  mysql: "root",
  mariadb: "root",
  mongodb: "app",
  redis: "default",
  clickhouse: "app",
};

/**
 * Pull the engine password out of a database's (decrypted) connection string.
 * Every form createDatabase emits carries it as the URL password
 * (`scheme://user:<pw>@host`), so a URL parse is the single source. Returns ""
 * when absent (an engine trusting local auth) rather than throwing.
 */
function passwordFromConn(conn: string): string {
  try {
    return decodeURIComponent(new URL(conn).password);
  } catch {
    return "";
  }
}

/**
 * Build the wire {@link DatabaseDescriptor} for a managed database. `container`
 * is the DB stack's deterministic container name (`container_name: db-<name>`
 * in the compose == `db.host`), so the agent execs into exactly it. The dump
 * user is engine-derived (see {@link DB_DUMP_USER}); the DB name is the logical
 * database the compose created (== `db.host`); the password rides decrypted over
 * mTLS.
 */
function databaseDescriptor(db: Database): DatabaseDescriptor {
  return {
    container: db.host,
    dbType: db.type,
    dbName: db.host,
    user: DB_DUMP_USER[db.type],
    password: passwordFromConn(decryptSecret(db.connectionStringEnc)),
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
  /** The target's own id (databaseId or projectId) — keys the object folder. */
  targetId: string;
  databaseId: string | null;
  projectId: string | null;
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
  projectId: string | null,
): Promise<ResolvedTarget> {
  if (kind === "database") {
    if (!databaseId) throw new Error("Backup has no database target");
    const db = read().databases.find((x) => x.id === databaseId && x.teamId === teamId);
    if (!db) throw new Error("Database not found");
    return {
      serverId: db.serverId,
      kind,
      targetId: db.id,
      databaseId: db.id,
      projectId: null,
      dbType: db.type,
      database: databaseDescriptor(db),
      label: `database ${db.name}`,
    };
  }
  if (!projectId) throw new Error("Backup has no project target");
  const project = await loadTeamProject(projectId, teamId);
  if (!project) throw new Error("Project not found");
  const descriptor = await buildProjectDescriptor(project);
  return {
    serverId: project.serverId,
    kind,
    targetId: project.id,
    databaseId: null,
    projectId: project.id,
    dbType: null,
    project: toWireProjectDescriptor(descriptor),
    label: `project ${project.name}`,
  };
}

/**
 * The ONE executor every real backup goes through — a schedule's "Run now"
 * (`runBackup`), an ad-hoc project run (`runProjectBackup`), and (Step 6) the
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
    projectId: string | null;
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
    projectId: opts.kind === "project" ? opts.projectId : null,
    destinationId: opts.destinationId,
    objectKey: "", // filled once the key is built (after resolution)
    sizeBytes: 0,
    status: "running",
    error: null,
    startedAt,
    finishedAt: null,
  };
  mutate((d) => {
    d.backupRuns.push(run);
    if (opts.backupId) {
      const b = d.backups.find((x) => x.id === opts.backupId);
      if (b) {
        b.lastRunAt = startedAt;
        b.lastStatus = "running";
      }
    }
  });

  // Resolve + dump under one try so EVERY failure (resolution, dial, the dump
  // itself) lands on the same `failed`-run path below.
  let label = opts.kind === "database" ? "database" : "project";
  let activityProjectId: string | null = opts.kind === "project" ? opts.projectId : null;
  let result: { ok: boolean; error: string; objectKey: string; sizeBytes: number } | null = null;
  let failure: string | null = null;
  let objectKey = "";
  try {
    const creds = getS3WithSecretsForTeam(teamId, opts.destinationId);
    const target = await resolveTarget(teamId, opts.kind, opts.databaseId, opts.projectId);
    label = target.label;
    activityProjectId = target.projectId;
    objectKey = buildObjectKey({
      teamId,
      kind: opts.kind,
      targetId: target.targetId,
      runId,
      ext: artifactExt(opts.kind, target.dbType),
      at: new Date(startedAt),
    });
    // Record the resolved key on the running record now, so a crash mid-dump
    // leaves the (single) object's key behind for a sweep.
    mutate((d) => {
      const r = d.backupRuns.find((x) => x.id === runId);
      if (r) r.objectKey = objectKey;
    });

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
    if (!failure) {
      try {
        await pruneRetention(teamId, target, creds.destination.id, opts.retentionDays);
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
  const finished = mutate((d): BackupRun => {
    const r = d.backupRuns.find((x) => x.id === runId)!;
    if (failure) {
      r.status = "failed";
      r.error = failure;
    } else {
      r.status = "success";
      r.error = null;
      r.objectKey = result!.objectKey;
      r.sizeBytes = result!.sizeBytes;
    }
    r.finishedAt = finishedAt;
    if (opts.backupId) {
      const b = d.backups.find((x) => x.id === opts.backupId);
      if (b) {
        b.lastRunAt = finishedAt;
        b.lastStatus = failure ? "failed" : "success";
      }
    }
    return { ...r };
  });

  recordActivity(
    "backup",
    failure
      ? `Backup of ${label} failed: ${failure}`
      : `Backed up ${label} (${formatBytes(finished.sizeBytes)})`,
    actor,
    activityProjectId,
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
  const candidates = read().backupRuns.filter(
    (r) =>
      r.teamId === teamId &&
      r.destinationId === destinationId &&
      r.targetKind === target.kind &&
      (target.kind === "database"
        ? r.databaseId === target.databaseId
        : r.projectId === target.projectId),
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
    const creds = getS3WithSecretsForTeam(teamId, destinationId);
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
  mutate((d) => {
    d.backupRuns = d.backupRuns.filter((r) => !removable.has(r.id));
  });
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

/** Run a backup SCHEDULE now (manual "Run now"). Real dump + upload + history. */
export async function runBackup(id: string): Promise<void> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const b = read().backups.find((x) => x.id === id && x.teamId === teamId);
  if (!b) throw new Error("Not found");
  await executeBackup(teamId, user.name, {
    backupId: b.id,
    kind: b.targetKind,
    databaseId: b.databaseId,
    projectId: b.projectId,
    destinationId: b.destinationId,
    retentionDays: b.retentionDays,
  });
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
      projectId: backup.projectId,
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
 * `retentionDays` defaults to the conventional 7 (no schedule to read it from).
 */
export async function runProjectBackup(
  projectId: string,
  destinationId: string,
  retentionDays = 7,
): Promise<BackupRun> {
  const { membership } = await requireCapability("manage_infra");
  const teamId = membership.teamId;
  const user = (await getCurrentUser())!;
  const d0 = read();
  if (!d0.projects.some((x) => x.id === projectId && x.teamId === teamId))
    throw new Error("Project not found");
  if (!d0.s3Destinations.some((x) => x.id === destinationId && x.teamId === teamId))
    throw new Error("Select a destination");
  return executeBackup(teamId, user.name, {
    backupId: null,
    kind: "project",
    databaseId: null,
    projectId,
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

  const run = read().backupRuns.find((r) => r.id === runId && r.teamId === teamId);
  if (!run) throw new Error("Backup run not found");
  if (run.status !== "success")
    throw new Error("This backup did not complete successfully and cannot be restored");

  const creds = getS3WithSecretsForTeam(teamId, run.destinationId);
  const target = await resolveTarget(
    teamId,
    run.targetKind,
    run.databaseId,
    run.projectId,
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

  recordActivity(
    "backup",
    failure
      ? `Restore of ${target.label} failed: ${failure}`
      : `Restored ${target.label} from a backup`,
    user.name,
    target.projectId,
    teamId,
  );
  if (failure) throw new Error(failure);
}

/**
 * The runs for a target's artifact list (project Backups tab / DB restore list),
 * newest first. Exactly one of `projectId` / `databaseId` is given; team-scoped.
 */
export async function listBackupRuns(filter: {
  projectId?: string;
  databaseId?: string;
}): Promise<BackupRun[]> {
  const teamId = await requireActiveTeamId();
  return read()
    .backupRuns.filter(
      (r) =>
        r.teamId === teamId &&
        (filter.projectId
          ? r.projectId === filter.projectId
          : filter.databaseId
            ? r.databaseId === filter.databaseId
            : false),
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function toggleBackup(
  id: string,
  enabled: boolean,
): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  mutate((d) => {
    const b = d.backups.find((x) => x.id === id && x.teamId === teamId);
    if (!b) throw new Error("Not found");
    b.enabled = enabled;
  });
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
  if (
    !read().s3Destinations.some(
      (x) => x.id === input.destinationId && x.teamId === teamId,
    )
  )
    throw new Error("Select a destination");

  let updated: Backup | undefined;
  mutate((d) => {
    const b = d.backups.find((x) => x.id === id && x.teamId === teamId);
    if (!b) throw new Error("Not found");
    b.name = input.name.trim();
    b.destinationId = input.destinationId;
    b.schedule = input.schedule || "0 3 * * *";
    b.retentionDays = Math.max(1, input.retentionDays || 7);
    updated = b;
  });
  recordActivity(
    "backup",
    `Updated backup schedule ${updated!.name}`,
    user.name,
    null,
    teamId,
  );
  return await toDTO(updated!);
}

export async function deleteBackup(id: string): Promise<void> {
  const teamId = (await requireCapability("manage_infra")).teamId;
  mutate((d) => {
    d.backups = d.backups.filter((x) => !(x.id === id && x.teamId === teamId));
  });
}

/**
 * Delete a target's S3 artifacts in ONE destination (its whole folder) via a
 * single prefix-delete — the "delete artifacts too" branch of DB/project
 * deletion (Step 5). Best-effort + idempotent: returns the count removed, or
 * throws only when no backup-capable agent can be reached. The caller decides
 * whether a failure blocks the target's deletion.
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
  const creds = getS3WithSecretsForTeam(teamId, input.destinationId);
  const prefix = targetPrefix(teamId, input.kind, input.targetId);

  let deleted = 0;
  const conn = await connectBackupAgent(input.serverId);
  try {
    const res = await conn.s3Delete(s3TargetFor(creds, prefix), true);
    deleted = res.deleted;
  } finally {
    conn.close();
  }

  mutate((d) => {
    d.backupRuns = d.backupRuns.filter(
      (r) =>
        !(
          r.teamId === teamId &&
          r.destinationId === input.destinationId &&
          r.targetKind === input.kind &&
          (input.kind === "database"
            ? r.databaseId === input.targetId
            : r.projectId === input.targetId)
        ),
    );
  });
  return deleted;
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
  const ids = new Set<string>();
  for (const r of read().backupRuns) {
    if (
      r.teamId === teamId &&
      r.targetKind === input.kind &&
      (input.kind === "database"
        ? r.databaseId === input.targetId
        : r.projectId === input.targetId)
    ) {
      ids.add(r.destinationId);
    }
  }
  return [...ids];
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
 * `deleteProject`). Run BEFORE the target row is deleted, so it still resolves to
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
  // Resolve the owning server straight off the target row — no agent round-trip
  // (a project's full descriptor needs `readStack`, which we don't need just to
  // delete objects). A missing/foreign row yields no server and nothing to do.
  const serverId =
    input.kind === "database"
      ? (read().databases.find(
          (x) => x.id === input.targetId && x.teamId === teamId,
        )?.serverId ?? null)
      : ((await loadTeamProject(input.targetId, teamId))?.serverId ?? null);

  const destinations = await backupDestinationsForTarget(input);
  if (destinations.length === 0) return { deleted: 0, failedDestinations: [] };
  if (!serverId) {
    // The target row is gone (or never ours) yet run records linger — there is no
    // owning agent left to reach the buckets. Drop the orphaned records so history
    // matches reality, and report the destinations as failed (their objects can't
    // be swept from here) so the caller doesn't claim a clean wipe.
    mutate((d) => {
      d.backupRuns = d.backupRuns.filter(
        (r) =>
          !(
            r.teamId === teamId &&
            r.targetKind === input.kind &&
            (input.kind === "database"
              ? r.databaseId === input.targetId
              : r.projectId === input.targetId)
          ),
      );
    });
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
export function reconcileInFlightBackupRuns(): number {
  const cutoff = Date.now() - RUN_ORPHAN_AFTER_MS;
  let reconciled = 0;
  const finishedAt = nowIso();
  mutate((d) => {
    const orphanedBackupIds = new Set<string>();
    for (const r of d.backupRuns) {
      if (r.status === "running" && new Date(r.startedAt).getTime() < cutoff) {
        r.status = "failed";
        r.error = "Interrupted by a control-plane restart and marked failed.";
        r.finishedAt = finishedAt;
        reconciled++;
        if (r.backupId) orphanedBackupIds.add(r.backupId);
      }
    }
    // A schedule stuck on `lastStatus:"running"` for an orphaned run settles too.
    for (const b of d.backups) {
      if (b.lastStatus === "running" && orphanedBackupIds.has(b.id)) {
        b.lastStatus = "failed";
      }
    }
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
