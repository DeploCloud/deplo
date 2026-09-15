import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { assembleBackupRun } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { requireMembership } from "../../membership";
import { recordActivity } from "../activity";
import { withKeyedLock } from "../keyed-mutex";
import { dispatchAlert } from "../../notify/dispatch";
import { setAppStatus } from "../apps/lifecycle";
import { mapBackupUnsupported } from "../../infra/agent-client/errors";
import { getDestinationWithSecretsForTeam } from "../destinations/credentials";
import { restoreFromDestination } from "../backup-transport";
import { requireBackupCapability } from "./target-access";
import { resolveTarget } from "./target-descriptor";

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
  await requireBackupCapability(run, "restore_backups");

  const creds = await getDestinationWithSecretsForTeam(
    teamId,
    run.destinationId,
  );
  let failure: string | null = null;
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
        run.sha256 ?? "",
      );
      if (!result.ok)
        failure = result.error || "the agent reported a failed restore";
    } catch (e) {
      failure = (mapBackupUnsupported(e) as Error).message;
    } finally {
      if (run.targetKind === "app" && target.appId)
        await setAppStatus(target.appId, failure ? "error" : "active");
    }
  });

  if (!failure && run.targetKind === "app" && target.appId) {
    const { rerouteApp } = await import("../../deploy/build/reroute");
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
