import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { loadAppGraph } from "./app-graph-load";
import { withKeyedLock } from "./keyed-mutex";
import { connectAgent } from "../infra/agent-client";
import {
  appMoveVolumeNames,
  appHasFilesDir,
  assertSafeVolumeNames,
} from "./project-backup-descriptor";
import {
  migrateWorkloadData,
  stopStackOn,
  startStackOn,
  destroyStackOn,
} from "./volume-migration";
import { recordActivity } from "./activity";

/**
 * Complete a pending cross-host data migration for an app, called from the deploy
 * pipeline right AFTER a successful deploy on the app's NEW server.
 */
export async function completePendingAppMigration(
  appId: string,
  emit: (level: "info" | "warn" | "error", text: string) => void,
): Promise<void> {
  // Serialize on the app id so two concurrent production deploys can't both run the
  // migration: the first clears the marker under the lock, the second re-reads inside
  // the lock, sees it gone, and no-ops.
  await withKeyedLock(`service-migrate:${appId}`, async () => {
    await runMigration(appId, emit);
  });
}

async function runMigration(
  appId: string,
  emit: (level: "info" | "warn" | "error", text: string) => void,
): Promise<void> {
  const service = await loadAppGraph(appId);
  if (!service) return;
  const fromServerId = service.migrateFromServerId;
  if (!fromServerId) return; // no pending migration — the common case
  const toServerId = service.serverId;
  const slug = service.slug;

  // A move onto the SAME server makes no sense, but guard anyway: clear the marker
  // and do nothing rather than copy a volume onto itself.
  if (fromServerId === toServerId) {
    await clearMigrationMarker(appId);
    return;
  }

  emit("info", `Migrating data from the previous server…`);

  // Enumerate the data volumes to copy from the OLD host's rendered stack — the OLD
  // host is where the DATA actually lives, so it is the source of truth for what to
  // copy.
  let volumeNames: string[] = [];
  try {
    const conn = await connectAgent(fromServerId);
    let renderedYaml = "";
    try {
      const stack = await conn.readStack(slug);
      renderedYaml = stack.exists ? stack.yaml : "";
    } finally {
      conn.close();
    }
    volumeNames = appMoveVolumeNames(service, renderedYaml);
    assertSafeVolumeNames(slug, volumeNames);
  } catch (e) {
    // Couldn't even enumerate — leave the old host intact, clear the marker, warn.
    await clearMigrationMarker(appId);
    emit(
      "warn",
      `Could not read the old server's stack to migrate data ` +
        `(${e instanceof Error ? e.message : String(e)}). The old server was left ` +
        `intact — its data was not copied. Recover it manually if needed.`,
    );
    return;
  }

  const includeFiles = appHasFilesDir(service);
  if (volumeNames.length === 0 && !includeFiles) {
    // Nothing enumerated to copy.
    await destroyStackOn(fromServerId, slug, false).catch(() => {});
    await clearMigrationMarker(appId);
    emit(
      "info",
      "No persistent data to migrate; stopped the old server's stack " +
        "(its volumes, if any, were left in place).",
    );
    return;
  }

  // Quiesce both stacks. If either won't stop we abort BEFORE copying — a running
  // source would give a torn copy, a running destination would race the untar.
  try {
    await stopStackOn(toServerId, slug);
    await stopStackOn(fromServerId, slug);
  } catch (e) {
    // Best-effort restart the new stack (we may have stopped it), leave old intact.
    await startStackOn(toServerId, slug).catch(() => {});
    await clearMigrationMarker(appId);
    emit(
      "warn",
      `Could not stop both stacks to migrate data safely ` +
        `(${e instanceof Error ? e.message : String(e)}). The old server was left ` +
        `intact — its data was not copied.`,
    );
    return;
  }

  // Copy volumes + files old → new. On failure, restart the new stack (empty) and
  // leave the old host intact so no data is lost; clear the marker + warn.
  try {
    await migrateWorkloadData(fromServerId, toServerId, {
      volumeNames,
      filesSlug: includeFiles ? slug : undefined,
    });
  } catch (e) {
    await startStackOn(toServerId, slug).catch(() => {});
    await clearMigrationMarker(appId);
    emit(
      "error",
      `Failed to copy data to the new server ` +
        `(${e instanceof Error ? e.message : String(e)}). The old server was left ` +
        `intact with its data — it was NOT torn down. To retry, move the app ` +
        `back to the old server and then move it again once the issue is fixed, or ` +
        `recover the data manually.`,
    );
    return;
  }

  // Copy succeeded — bring the new stack up on the migrated data.
  try {
    await startStackOn(toServerId, slug);
  } catch (e) {
    // The data is on the new host but the stack didn't restart. Don't tear down the
    // old host (belt-and-braces); clear the marker + warn so a redeploy can recover.
    await clearMigrationMarker(appId);
    emit(
      "warn",
      `Data copied, but the new stack did not restart ` +
        `(${e instanceof Error ? e.message : String(e)}). Redeploy to bring it up. ` +
        `The old server was left intact.`,
    );
    return;
  }

  // Tear down the OLD host + its volumes now that the data is safely on the new one.
  // Best-effort: the migration is done, so a failed teardown is a warning (an
  // orphaned old stack), not a failure.
  let teardownWarning = "";
  await destroyStackOn(fromServerId, slug).catch((e) => {
    teardownWarning =
      ` The old server's stack could not be torn down ` +
      `(${e instanceof Error ? e.message : String(e)}) — remove it manually.`;
  });

  await clearMigrationMarker(appId);
  emit(
    teardownWarning ? "warn" : "info",
    `Data migrated to the new server.` + teardownWarning,
  );
  await recordActivity(
    "app",
    `Migrated ${service.name}'s data to its new server`,
    "system",
    appId,
  );
}

/** Clear the pending-migration marker (a no-op UPDATE if the row is gone). */
async function clearMigrationMarker(appId: string): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ migrateFromServerId: null })
    .where(eq(appsTable.id, appId));
}
