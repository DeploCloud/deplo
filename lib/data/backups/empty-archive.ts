import "server-only";

import { gunzipSync } from "node:zlib";

import { and, eq, isNotNull, lte } from "drizzle-orm";

import { getDb } from "../../db/client";
import { backupRuns as backupRunsTable } from "../../db/schema/control-plane/backups";
import { tarEntries } from "../../infra/tar-stream";
import { openArtifactDownload } from "../backup-transport";
import { recordActivity } from "../activity";
import { loadTeamApp } from "../app-graph-load";
import { buildProjectDescriptor } from "../project-backup-descriptor";
import {
  destinationServerId,
  getDestinationWithSecretsForTeam,
  type DestinationWithSecrets,
} from "../destinations/credentials";
import { anyBackupCapableServer } from "./target-lookup";

// An App's archive this small is read back whole; a bigger one holds data by its size alone.
export const READ_BACK_MAX_BYTES = 64 * 1024;

export const emptyArchiveMessage = (label: string) =>
  `its archive holds no file of ${label}'s data, so it is not a backup`;

/** Whether an App's archive holds a file of its volumes. */
export async function archiveHoldsData(
  creds: DestinationWithSecrets,
  viaServerId: string,
  objectKey: string,
  sha256: string,
): Promise<boolean> {
  const dl = await openArtifactDownload(creds, viaServerId, objectKey, sha256);
  const parts: Buffer[] = [];
  try {
    for await (const c of dl.chunks) parts.push(c);
  } finally {
    dl.close();
  }
  const tar = gunzipSync(Buffer.concat(parts));
  for await (const e of tarEntries(
    (async function* () {
      yield tar;
    })(),
  ))
    if (e.name.startsWith("volumes/")) return true;
  return false;
}

const CHECKED_KEY = Symbol.for("deplo.backups.archive-checked");
const g = globalThis as unknown as { [CHECKED_KEY]?: Set<string> };
const checked = (g[CHECKED_KEY] ??= new Set<string>());

/** Turns an App's kept backup whose archive holds none of its data into a failed one; each run is read once. */
export async function failEmptyAppBackups(): Promise<number> {
  const rows = await getDb()
    .select()
    .from(backupRunsTable)
    .where(
      and(
        eq(backupRunsTable.status, "success"),
        eq(backupRunsTable.targetKind, "app"),
        isNotNull(backupRunsTable.appId),
        lte(backupRunsTable.sizeBytes, READ_BACK_MAX_BYTES),
      ),
    );
  let failed = 0;
  for (const r of rows) {
    if (checked.has(r.id) || !r.objectKey) continue;
    try {
      const app = await loadTeamApp(r.appId!, r.teamId);
      if (!app || (await buildProjectDescriptor(app)).volumeNames.length === 0)
        continue;
      const creds = await getDestinationWithSecretsForTeam(
        r.teamId,
        r.destinationId,
      );
      const via =
        destinationServerId(creds.destination, app.serverId) ||
        (await anyBackupCapableServer());
      if (!via) continue;
      const holds = await archiveHoldsData(
        creds,
        via,
        r.objectKey,
        r.sha256 ?? "",
      );
      checked.add(r.id);
      if (holds) continue;
      const why = emptyArchiveMessage(app.name);
      const flipped = await getDb()
        .update(backupRunsTable)
        .set({ status: "failed", error: why })
        .where(
          and(
            eq(backupRunsTable.id, r.id),
            eq(backupRunsTable.status, "success"),
          ),
        )
        .returning({ id: backupRunsTable.id });
      if (flipped.length === 0) continue;
      failed++;
      await recordActivity(
        "backup",
        `A backup of ${app.name} from ${r.startedAt.slice(0, 16).replace("T", " ")} UTC is no longer restorable: ${why}.`,
        "Deplo",
        app.id,
        r.teamId,
      );
    } catch (e) {
      console.warn(
        `[backups] could not read back ${r.objectKey}: ${e instanceof Error ? e.message : String(e)} (will retry)`,
      );
    }
  }
  return failed;
}
