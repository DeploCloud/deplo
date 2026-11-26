import "server-only";

import { and, eq, gt } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../../db/schema/control-plane/backups";
import { assembleBackupRun, backupRunToRow } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { newId, nowIso } from "../../ids";
import { requireMembership } from "../../membership";
import { recordActivity } from "../activity";
import { heldLabel } from "../../backup-hold";
import { dispatchAlert } from "../../notify/dispatch";
import { PostgresArchive } from "../../agent/gen/agent";
import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import { POSTGRES_ARCHIVE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import {
  AgentOfflineError,
  mapBackupUnsupported,
} from "../../infra/agent-client/errors";
import { backupServerOffline } from "./offline";
import { unreachableMessage } from "../../infra/server-health";
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
import { resolveTarget, targetLabel } from "./target-descriptor";
import { MAX_RUNS_PER_TARGET, pruneRetention } from "./retention";
import { formatBytes } from "./format-bytes";
import { roomForBackup } from "./room";
import { scheduleDatabaseBundle } from "../clusters/database-bundles";
import { outOfReachFailure } from "../clusters/reach";
import { takeTurn } from "../clusters/copy-turns";
import { liveCopy, nothingYetMessage, saySkippedOnce } from "./live-copy";
import { expireSetAsideCopies } from "../apps/set-aside";
import {
  archiveHoldsData,
  emptyArchiveMessage,
  READ_BACK_MAX_BYTES,
} from "./empty-archive";
import type { BackupRun, BackupTargetKind } from "../../types/backup";

// The agent's errNoVolumeFiles, word for word (deplo-agent internal/server/backup_project.go).
const AGENT_NO_VOLUME_FILE =
  "the App's data holds no file on this server, so its archive is not a backup";

// On globalThis: a scheduled run starts in the scheduler's bundle and is canceled from a request's (eu, 24 Nov
// 2026: a canceled scheduled backup went on copying, the cancel never reached it).
/** A scheduled backup that missed its 1 s pause: the scheduler tries it again once, later in the hour (c49). */
export class PauseMissedError extends Error {}
const missedPause = (failure: string | null) =>
  !!failure?.includes("of pausing it");

const IN_FLIGHT_KEY = Symbol.for("deplo.backups.in-flight");
const inFlight = globalThis as unknown as {
  [IN_FLIGHT_KEY]?: Map<string, AbortController>;
};
export const backupRunsInFlight = (inFlight[IN_FLIGHT_KEY] ??= new Map<
  string,
  AbortController
>());

// Read from the ROW, not from memory: two runs seconds apart once tarred one 61 GB volume in parallel.
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
    /** The schedule's runs are base backups, for as long as the database archives its change log. */
    baseBackup?: boolean;
    /** A missed pause is no failure yet: no alert, and PauseMissedError for the scheduler to try again. */
    retryMissedPause?: boolean;
    /** The second try of a run that missed its pause. */
    secondTry?: boolean;
  },
): Promise<BackupRun> {
  const startedAt = nowIso();
  const runId = newId("brun");
  const targetKey =
    (opts.kind === "database" ? opts.databaseId : opts.appId) ?? "";
  if (targetKey) await assertNotAlreadyBackingUp(teamId, targetKey);
  // Only the copy that runs is backed up: a stopped or stale one is skipped, never kept (c43: 398 B of memos).
  const said = {
    appId: opts.kind === "app" ? opts.appId : null,
    databaseId: opts.kind === "database" ? opts.databaseId : null,
  };
  const live = targetKey ? await liveCopy(teamId, opts.kind, targetKey) : null;
  if (live?.skip) {
    await saySkippedOnce(teamId, said, actor, live.skip);
    throw new Error(live.skip);
  }
  const run: BackupRun = {
    id: runId,
    teamId,
    backupId: opts.backupId,
    targetKind: opts.kind,
    databaseId: opts.kind === "database" ? opts.databaseId : null,
    appId: opts.kind === "app" ? opts.appId : null,
    destinationId: opts.destinationId,
    // Denormalized: the two FK columns above are ON DELETE SET NULL, so deleting the target blanks them.
    targetId: (opts.kind === "database" ? opts.databaseId : opts.appId) ?? "",
    objectKey: "",
    sizeBytes: 0,
    decryptedSizeBytes: null,
    heldMs: null,
    path: null,
    sha256: null,
    orphanedAt: null,
    status: "running",
    error: null,
    startedAt,
    finishedAt: null,
  };
  const before = await getDb().transaction(async (tx) => {
    await tx.insert(backupRunsTable).values(backupRunToRow(run));
    if (opts.backupId) {
      const [prev] = await tx
        .select({
          lastRunAt: backupsTable.lastRunAt,
          lastStatus: backupsTable.lastStatus,
        })
        .from(backupsTable)
        .where(eq(backupsTable.id, opts.backupId));
      await tx
        .update(backupsTable)
        .set({ lastRunAt: startedAt, lastStatus: "running" })
        .where(eq(backupsTable.id, opts.backupId));
      return prev;
    }
  });

  let label = await targetLabel(teamId, opts.kind, opts.databaseId, opts.appId);
  let activityAppId: string | null = opts.kind === "app" ? opts.appId : null;
  let activityDatabaseId: string | null =
    opts.kind === "database" ? opts.databaseId : null;
  let targetServerId = "";
  let result: BackupOutcome | null = null;
  let failure: string | null = null;
  // How long the App was paused, kept on a failed run too (c46: the 1 s pause's own failure had none).
  let heldMs: number | null = null;
  // A live copy whose data holds no file yet is no backup and no failure: nothing is kept or alerted.
  let nothingYet = false;
  let objectKey = "";
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
    // A server that cannot write one keeps the dump: a failover then restores that, without the change log.
    const base =
      !!opts.baseBackup &&
      !!target.archivesChangeLog &&
      (await serverSupports(target.serverId, POSTGRES_ARCHIVE_CAPABILITY));
    objectKey = buildObjectKey({
      teamId,
      kind: opts.kind,
      targetId: target.targetId,
      runId,
      ext: artifactExt(
        opts.kind,
        target.dbType,
        Boolean(creds.destination.ageRecipient),
        base,
      ),
      at: new Date(startedAt),
    });
    await getDb()
      .update(backupRunsTable)
      .set({ objectKey })
      .where(eq(backupRunsTable.id, runId));

    const transport = {
      serverId: target.serverId,
      kind: opts.kind,
      database: target.database,
      project: target.project,
      ...(base ? { archive: PostgresArchive.POSTGRES_ARCHIVE_BASE } : {}),
    };
    // One copy at a time on each end (ADR-0043): the run waits its turn, and its row says for what.
    const release = await takeTurn(
      [
        target.serverId,
        destinationServerId(creds.destination, target.serverId),
      ],
      `a backup of ${label}`,
      { signal: abort.signal, note: runId },
    );
    try {
      failure = abort.signal.aborted
        ? "canceled"
        : await roomForBackup(creds, transport, target.targetId);
      if (!failure) {
        result = await backupToDestination(
          creds,
          transport,
          objectKey,
          abort.signal,
        );
        heldMs = result.heldMs || null;
        if (!result.ok)
          failure = result.error || "the agent reported a failed backup";
        nothingYet = !!live?.runs && result.error === AGENT_NO_VOLUME_FILE;
      }
    } finally {
      release();
    }

    if (
      !failure &&
      result?.ok &&
      target.project?.volumeNames.length &&
      result.sizeBytes <= READ_BACK_MAX_BYTES &&
      !(await archiveHoldsData(
        creds,
        destinationServerId(creds.destination, target.serverId),
        result.objectKey,
        result.sha256,
      ).catch(() => true))
    ) {
      failure = emptyArchiveMessage(label);
      nothingYet = !!live?.runs;
      await removeLanded(creds, target.serverId, result.objectKey, runId);
      result = null;
    }

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
    // A server that dropped away mid-run is offline: say which, never the transport's words.
    const offline = unreachableMessage(e);
    const down = e instanceof AgentOfflineError ? e.serverId : targetServerId;
    failure =
      (offline &&
        (await outOfReachFailure(down, "take this backup").catch(
          () => null,
        ))) ??
      (await backupServerOffline(e, targetServerId).catch(() => null)) ??
      offline ??
      (mapBackupUnsupported(e) as Error).message;
  } finally {
    backupRunsInFlight.delete(runId);
  }
  if (failure && activityAppId && targetServerId)
    failure =
      (await cutByMove(activityAppId, targetServerId, label)) ?? failure;

  if (nothingYet && live) {
    const message = await nothingYetMessage(label, live.server);
    const dropped = await getDb()
      .delete(backupRunsTable)
      .where(
        and(
          eq(backupRunsTable.id, runId),
          eq(backupRunsTable.status, "running"),
        ),
      )
      .returning({ id: backupRunsTable.id });
    if (dropped.length === 0) throw new Error("This backup was canceled");
    if (opts.backupId && before)
      await getDb()
        .update(backupsTable)
        .set(before)
        .where(eq(backupsTable.id, opts.backupId));
    await saySkippedOnce(teamId, said, actor, message);
    throw new Error(message);
  }

  const finishedAt = nowIso();
  let canceled = false;
  // A backup that lands after its App or database was deleted is removed, never kept as a backup (ADR-0043).
  const gone = !failure && (await targetGone(opts));
  if (gone) {
    failure = "its App or database was deleted while it ran";
    if (result?.ok && result.objectKey && creds)
      await removeLanded(creds, targetServerId, result.objectKey, runId);
    result = null;
  }
  const finished = await getDb().transaction(async (tx): Promise<BackupRun> => {
    const set = failure
      ? { status: "failed" as const, error: failure, heldMs, finishedAt }
      : {
          status: "success" as const,
          error: null,
          objectKey: result!.objectKey,
          sizeBytes: result!.sizeBytes,
          decryptedSizeBytes: result!.decryptedSizeBytes || null,
          heldMs,
          path: result!.path ?? null,
          sha256: result!.sha256 || null,
          finishedAt,
        };
    const updated = await tx
      .update(backupRunsTable)
      .set(set)
      .where(
        and(
          eq(backupRunsTable.id, runId),
          // running is part of the WHERE: a cancel that landed meanwhile must not be flipped back to success.
          eq(backupRunsTable.status, "running"),
        ),
      )
      .returning();
    if (updated.length === 0) {
      const still = await tx
        .select({ status: backupRunsTable.status })
        .from(backupRunsTable)
        .where(eq(backupRunsTable.id, runId))
        .limit(1);
      // No row left: its target was deleted meanwhile, with its backups.
      canceled = !still[0] || still[0].status === "canceled";
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

  // A cancel can cut off the answer of a copy that already landed: its key goes either way.
  if (canceled) {
    const landed = result?.objectKey || objectKey;
    if (landed && creds)
      await removeLanded(creds, targetServerId, landed, runId);
    throw new Error("This backup was canceled");
  }
  if (gone) throw new Error(`Backup of ${label} stopped: ${failure}`);

  // A database on a cluster fails over from its latest backup: its leader learns of this one now (#202).
  if (!failure && opts.kind === "database" && opts.databaseId)
    scheduleDatabaseBundle(opts.databaseId);

  const retry = !!opts.retryMissedPause && missedPause(failure);
  await recordActivity(
    "backup",
    retry
      ? `Backup of ${label} will be tried again later this hour, when it is quieter: ${failure}`
      : failure
        ? `Backup of ${label} failed${opts.secondTry && missedPause(failure) ? " a second time" : ""}: ${failure}`
        : `Backed up ${label} (${formatBytes(finished.sizeBytes)})${
            result?.heldWhy
              ? `. It was paused for the whole copy (${heldLabel(result.heldMs)?.replace(/^App paused /, "") ?? "briefly"}): ${result.heldWhy}`
              : ""
          }`,
    actor,
    activityAppId,
    teamId,
    null,
    activityDatabaseId,
  );
  if (retry) throw new PauseMissedError(failure!);
  dispatchAlert({
    teamId,
    key: failure ? "backup_failed" : "backup_succeeded",
    title: failure ? `Backup of ${label} failed` : `Backed up ${label}`,
    body: failure ?? `${formatBytes(finished.sizeBytes)} uploaded.`,
    path: "/storage",
    appId: activityAppId,
  });

  // Each backup of a cluster App also clears what its servers set aside of it long ago.
  if (activityAppId) await expireSetAsideCopies(activityAppId).catch(() => {});
  if (failure) throw new Error(failure);
  return finished;
}

// c49: a backup cut by a move said the agent's words ("no such volume").
async function cutByMove(
  appId: string,
  ranOn: string,
  label: string,
): Promise<string | null> {
  const [app] = await getDb()
    .select({ serverId: appsTable.serverId, server: serversTable.name })
    .from(appsTable)
    .leftJoin(serversTable, eq(serversTable.id, appsTable.serverId))
    .where(eq(appsTable.id, appId));
  if (!app?.serverId || app.serverId === ranOn) return null;
  return `canceled by the move of ${label} to ${app.server ?? "another server"}`;
}

async function removeLanded(
  creds: NonNullable<
    Awaited<ReturnType<typeof getDestinationWithSecretsForTeam>>
  >,
  targetServerId: string,
  objectKey: string,
  runId: string,
): Promise<void> {
  try {
    const via =
      destinationServerId(creds.destination, targetServerId) ||
      (await anyBackupCapableServer());
    if (via) await deleteFromDestination(creds, via, objectKey);
  } catch (e) {
    console.warn(
      `[backups] run ${runId} left ${objectKey} behind: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Its App or database is gone, or on its way out. */
async function targetGone(opts: {
  kind: BackupTargetKind;
  appId: string | null;
  databaseId: string | null;
}): Promise<boolean> {
  const db = getDb();
  if (opts.kind === "app" && opts.appId) {
    const [a] = await db
      .select({ deletingAt: appsTable.deletingAt })
      .from(appsTable)
      .where(eq(appsTable.id, opts.appId))
      .limit(1);
    return !a || !!a.deletingAt;
  }
  if (opts.kind === "database" && opts.databaseId) {
    const [d] = await db
      .select({ id: databasesTable.id })
      .from(databasesTable)
      .where(eq(databasesTable.id, opts.databaseId))
      .limit(1);
    return !d;
  }
  return false;
}

/** A delete stops its target's running backups first: what one already wrote goes (ADR-0043). */
export async function cancelBackupsOfDeleted(targetId: string): Promise<void> {
  const running = await getDb()
    .update(backupRunsTable)
    .set({
      status: "canceled",
      error: "Its App or database was deleted",
      finishedAt: nowIso(),
    })
    .where(
      and(
        eq(backupRunsTable.targetId, targetId),
        eq(backupRunsTable.status, "running"),
      ),
    )
    .returning({ id: backupRunsTable.id });
  for (const r of running) backupRunsInFlight.get(r.id)?.abort();
}

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

  const stopped = await getDb()
    .update(backupRunsTable)
    .set({
      status: "canceled",
      error: `Canceled by ${user.name}`,
      finishedAt: nowIso(),
    })
    .where(
      // Compare-and-swap first, abort second: a dump that finished a second ago keeps its real artifact.
      and(eq(backupRunsTable.id, runId), eq(backupRunsTable.status, "running")),
    )
    .returning({ id: backupRunsTable.id });
  if (stopped.length === 0) return false;

  if (run.backupId)
    await getDb()
      .update(backupsTable)
      .set({ lastStatus: "canceled" })
      .where(
        and(eq(backupsTable.id, run.backupId), eq(backupsTable.teamId, teamId)),
      );

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
