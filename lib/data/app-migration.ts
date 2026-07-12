import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { services as servicesTable } from "../db/schema/control-plane";
import { loadServiceGraph } from "./service-graph-load";
import { withKeyedLock } from "./keyed-mutex";
import { connectAgent } from "../infra/agent-client";
import {
  serviceMoveVolumeNames,
  serviceHasFilesDir,
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
 * Complete a pending cross-host data migration for a service, called from the
 * deploy pipeline right AFTER a successful deploy on the service's NEW server.
 *
 * A service server move is lazy: updateServiceSource reassigns `serverId` and, when
 * the OLD host still holds a running stack, records `migrateFromServerId` (the old
 * host) and triggers a deploy on the new host. That deploy rebuilds the service from
 * source and brings it up with FRESH EMPTY volumes. This function then copies the
 * real data across so it FOLLOWS the move:
 *
 *   1. enumerate the service's data volumes on the NEW host's rendered stack
 *      (external volumes excluded — Deplo doesn't own them);
 *   2. stop BOTH stacks (new so nothing writes its volumes under the untar, old for
 *      a consistent read);
 *   3. copy every volume + the files dir old → new (wipe-first, overwriting the
 *      empty fresh-deploy volumes);
 *   4. restart the NEW stack on the migrated data;
 *   5. tear down the OLD stack + its volumes (best-effort);
 *   6. clear `migrateFromServerId`.
 *
 * The deploy already succeeded and the marker is set, so this runs at most once per
 * move. On failure it does NOT leave the marker set (that would re-run the copy on
 * every future deploy); instead it clears the marker and surfaces a clear warning —
 * the OLD host is left INTACT (never torn down on a failed copy), so the operator
 * can recover the data manually. Returns a human message for the deploy log, or null
 * when there was nothing to migrate.
 */
export async function completePendingServiceMigration(
  serviceId: string,
  emit: (level: "info" | "warn" | "error", text: string) => void,
): Promise<void> {
  // Serialize on the service id so two concurrent production deploys can't both run
  // the migration: the first clears the marker under the lock, the second re-reads
  // inside the lock, sees it gone, and no-ops. Same lifecycle lock the DB moves use.
  // NB: withKeyedLock is PROCESS-LOCAL (keyed-mutex.ts) — correct for the single
  // `next start` process this app runs as; a multi-process deployment would need a
  // DB-level guard (a conditional UPDATE on the marker) instead.
  await withKeyedLock(`service-migrate:${serviceId}`, async () => {
    await runMigration(serviceId, emit);
  });
}

async function runMigration(
  serviceId: string,
  emit: (level: "info" | "warn" | "error", text: string) => void,
): Promise<void> {
  const service = await loadServiceGraph(serviceId);
  if (!service) return;
  const fromServerId = service.migrateFromServerId;
  if (!fromServerId) return; // no pending migration — the common case
  const toServerId = service.serverId;
  const slug = service.slug;

  // A move onto the SAME server makes no sense, but guard anyway: clear the marker
  // and do nothing rather than copy a volume onto itself.
  if (fromServerId === toServerId) {
    await clearMigrationMarker(serviceId);
    return;
  }

  emit("info", `Migrating data from the previous server…`);

  // Enumerate the data volumes to copy from the OLD host's rendered stack — the OLD
  // host is where the DATA actually lives, so it is the source of truth for what to
  // copy. (Reading the NEW host's freshly-deployed stack would be wrong: if this
  // move ALSO edited the compose to declare fewer volumes, the dropped volumes still
  // hold data on the old host that must migrate — enumerating from the new stack
  // would silently skip them and then destroy them below.) external: volumes are
  // excluded (Deplo doesn't own them); the names are validated for the clear
  // "interpolated volume name" error before they reach the wire.
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
    volumeNames = serviceMoveVolumeNames(service, renderedYaml);
    assertSafeVolumeNames(slug, volumeNames);
  } catch (e) {
    // Couldn't even enumerate — leave the old host intact, clear the marker, warn.
    await clearMigrationMarker(serviceId);
    emit(
      "warn",
      `Could not read the old server's stack to migrate data ` +
        `(${e instanceof Error ? e.message : String(e)}). The old server was left ` +
        `intact — its data was not copied. Recover it manually if needed.`,
    );
    return;
  }

  const includeFiles = serviceHasFilesDir(service);
  if (volumeNames.length === 0 && !includeFiles) {
    // Nothing enumerated to copy. Tear down the old host, but WITHOUT removing
    // volumes: if the enumeration somehow missed a volume that still holds data,
    // a plain `down` orphans it (recoverable by hand) rather than destroying it.
    // A genuinely stateless service has no volumes, so nothing is orphaned.
    await destroyStackOn(fromServerId, slug, false).catch(() => {});
    await clearMigrationMarker(serviceId);
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
    await clearMigrationMarker(serviceId);
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
    await clearMigrationMarker(serviceId);
    emit(
      "error",
      `Failed to copy data to the new server ` +
        `(${e instanceof Error ? e.message : String(e)}). The old server was left ` +
        `intact with its data — it was NOT torn down. To retry, move the service ` +
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
    await clearMigrationMarker(serviceId);
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

  await clearMigrationMarker(serviceId);
  emit(
    teardownWarning ? "warn" : "info",
    `Data migrated to the new server.` + teardownWarning,
  );
  await recordActivity(
    "service",
    `Migrated ${service.name}'s data to its new server`,
    "system",
    serviceId,
  );
}

/** Clear the pending-migration marker (a no-op UPDATE if the row is gone). */
async function clearMigrationMarker(serviceId: string): Promise<void> {
  await getDb()
    .update(servicesTable)
    .set({ migrateFromServerId: null })
    .where(eq(servicesTable.id, serviceId));
}
