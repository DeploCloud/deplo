import "server-only";

import { and, eq, gt } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { assembleBackupRun, backupRunToRow } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireMembership } from "../../membership";
import { recordActivity } from "../activity";
import { dispatchAlert } from "../../notify/dispatch";
import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import { mapBackupUnsupported } from "../../infra/agent-client/errors";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
} from "../destinations/credentials";
import {
  backupToDestination,
  deleteFromDestination,
  type BackupOutcome,
} from "../backup-transport";
import { artifactExt, buildObjectKey } from "../backup-objectkey";
import { anyBackupCapableServer, downloadTargetFor } from "./target-lookup";
import { requireBackupCapability } from "./target-access";
import { resolveTarget } from "./target-descriptor";
import { MAX_RUNS_PER_TARGET, pruneRetention } from "./retention";
import { formatBytes } from "./format-bytes";
import type { BackupRun, BackupTargetKind } from "../../types/backup";

// The dumps this process is driving, by run id, so "Stop" can reach one halfway
// through a 25 GB tar: aborting the controller cancels the gRPC stream, so the
// work stops ON THE HOST. In-memory, single process.
export const backupRunsInFlight = new Map<string, AbortController>();

// assertNotAlreadyBackingUp - refuse to dump a workload already being dumped: two
// runs five seconds apart tarred one 61 GB volume in parallel. Read from the ROW,
// so a second control plane on the same database is caught.
export async function assertNotAlreadyBackingUp(
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

// executeBackup - the ONE executor every real backup goes through: "Run now", an
// ad-hoc project run, and the scheduler.
export async function executeBackup(
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
  // The target id is known up front, so the run record is appended BEFORE the
  // expensive resolution (a project's descriptor build dials the agent).
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
  // Kept out here for the cancel cleanup below.
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
    // Recorded on the running record now, so a crash mid-dump leaves the
    // object's key behind for a sweep.
    await getDb()
      .update(backupRunsTable)
      .set({ objectKey })
      .where(eq(backupRunsTable.id, runId));

    // WHERE the bytes go - bucket, this host's disk, another server's - is
    // entirely backup-transport's problem.
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
    // The record can be gone (deleting a target sweeps its run history) or no
    // longer `running` (it was canceled).
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

// cancelBackupRun - stop a running backup. The ORDER is the point: the record is
// flipped first as a compare-and-swap on `running`, so the dump finishing a second
// later cannot undo it; then the stream is aborted, so the tar stops on the host.
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
