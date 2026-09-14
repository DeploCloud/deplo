import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { migrationRunItems as runItemsTable } from "../db/schema/control-plane/migration";
import { nowIso } from "../ids";
import { recordActivity } from "./activity";
import { getCurrentUser } from "../auth/current-user";
import { requireCapability } from "../membership";
import { loadAppGraph } from "./app-graph-load";
import { requireAppCapability } from "./node-access";
import { appOwnVolumeNames } from "./project-backup-descriptor";
import { teardownOrQueue } from "./teardown-queue";

/** What a refused start says, everywhere it is refused. */
export function assertDataCopyIntact(
  name: string,
  dataCopyError: string,
): void {
  if (!dataCopyError) return;
  throw new Error(
    `${name}'s data did not come across: ${dataCopyError}. Starting it now would ` +
      `run it on empty storage. Bring the data over yourself, or choose ` +
      `"Deploy anyway" on its page to accept starting without it.`,
  );
}

/** Which of the two tables a marker lives on. */
export type DataCopyTarget = { kind: "app" | "database"; id: string };

// markDataCopyFailed records why a copy did not land; it never throws.
export async function markDataCopyFailed(
  target: DataCopyTarget,
  message: string,
  opts?: { unlessCopiedIn?: string },
): Promise<void> {
  if (
    opts?.unlessCopiedIn &&
    (await dataAlreadyCopiedInto(opts.unlessCopiedIn, target.id))
  )
    return;
  const text = message.trim() || "the copy failed";
  try {
    if (target.kind === "app")
      await getDb()
        .update(appsTable)
        .set({ dataCopyError: text, updatedAt: nowIso() })
        .where(eq(appsTable.id, target.id));
    else
      await getDb()
        .update(databasesTable)
        .set({ dataCopyError: text })
        .where(eq(databasesTable.id, target.id));
  } catch {
    // Swallowed: a marker that could not be written must not fail the whole import.
  }
}

// dataAlreadyCopiedInto reports whether this run already put bytes into that row.
export async function dataAlreadyCopiedInto(
  runId: string,
  targetId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: runItemsTable.id })
    .from(runItemsTable)
    .where(
      and(
        eq(runItemsTable.runId, runId),
        eq(runItemsTable.targetId, targetId),
        eq(runItemsTable.sourceKind, "volume"),
        eq(runItemsTable.outcome, "created"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// clearDataCopyError clears the marker because the data IS here now; never throws.
export async function clearDataCopyError(
  target: DataCopyTarget,
): Promise<void> {
  try {
    if (target.kind === "app")
      await getDb()
        .update(appsTable)
        .set({ dataCopyError: "", updatedAt: nowIso() })
        .where(eq(appsTable.id, target.id));
    else
      await getDb()
        .update(databasesTable)
        .set({ dataCopyError: "" })
        .where(eq(databasesTable.id, target.id));
  } catch {
    // Swallowed: a marker that could not be written must not fail the whole import.
  }
}

// acceptDataCopyLoss is "Deploy anyway": start without the data that did not arrive.
export async function acceptDataCopyLoss(
  target: DataCopyTarget,
): Promise<void> {
  const user = (await getCurrentUser())!;
  if (target.kind === "app") {
    const { membership } = await requireAppCapability(target.id, "deploy_apps");
    const app = await loadAppGraph(target.id);
    // A held MOVE: accepting the loss also ends the move.
    const heldMove =
      app?.teamId === membership.teamId ? app.migrateFromServerId : null;
    const [row] = await getDb()
      .update(appsTable)
      .set({
        dataCopyError: "",
        migrateFromServerId: null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(appsTable.id, target.id),
          eq(appsTable.teamId, membership.teamId),
        ),
      )
      .returning({ name: appsTable.name });
    if (!row) throw new Error("App not found");
    if (app && heldMove)
      await teardownOrQueue({
        serverId: heldMove,
        deployKey: app.slug,
        projectLabel: app.id,
        label: app.name,
        teamId: app.teamId,
        reclaimVolumes: appOwnVolumeNames(app),
      }).catch(() => {});
    await recordActivity(
      "app",
      heldMove
        ? `Deployed ${row.name} without the data its previous server still holds`
        : `Deployed ${row.name} without the data a migration could not copy`,
      user.name,
      target.id,
    );
    return;
  }
  const { teamId } = await requireCapability("control_databases");
  const [row] = await getDb()
    .update(databasesTable)
    .set({ dataCopyError: "" })
    .where(
      and(eq(databasesTable.id, target.id), eq(databasesTable.teamId, teamId)),
    )
    .returning({ name: databasesTable.name });
  if (!row) throw new Error("Database not found");
  await recordActivity(
    "database",
    `Started ${row.name} without the data a migration could not copy`,
    user.name,
    // A database id in the `app_id` slot violates that column's FK.
    null,
    teamId,
    null,
    target.id,
  );
}
