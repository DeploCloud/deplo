import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { assembleBackupRun } from "../backup-rows";
import { getCurrentUser } from "../../auth/current-user";
import { requireMembership } from "../../membership";
import { recordActivity } from "../activity";
import { requireAppCapability } from "../node-access";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
} from "../destinations/credentials";
import { openArtifactDownload } from "../backup-transport";
import { anyBackupCapableServer, downloadTargetFor } from "./target-lookup";
import { requireBackupCapability } from "./target-access";
import type { BackupRun } from "../../types/backup";

// downloadBackupArtifact - stream one backup artifact out, decrypted, for the
// download route. The caller MUST call `close()` once the response is finished -
// the agent connection stays open behind it.
export async function downloadBackupArtifact(runId: string): Promise<{
  filename: string;
  // The exact bytes the stream will produce, or null when the run never recorded
  // it: advertising it would leave the browser waiting for bytes never coming.
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

  // Recorded when the stream OPENS, not when it finishes, and worded for that instant.
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

// downloadFilename - the name the browser saves the artifact under.
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
