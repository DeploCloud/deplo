import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
  migrationRunItems as runItemsTable,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";
import { recordActivity } from "./activity";
import { getCurrentUser } from "../auth";
import { requireCapability } from "../membership";
import { requireAppCapability } from "./node-access";

/**
 * The one column that says "this workload's data did not arrive", and the refusal
 * every way of starting it goes through.
 */

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

/**
 * Record why a copy did not land, on the row itself. It never throws: a marker
 * that could not be written must not turn one failed volume into a failed import,
 * and the report line is written either way.
 */
export async function markDataCopyFailed(
  target: DataCopyTarget,
  message: string,
  /** The run whose earlier pass may already have delivered the bytes. Given, a
   *  failure that touched nothing leaves a landed copy alone. */
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
    // Deliberately swallowed: see above.
  }
}

/**
 * Whether this run already put bytes into that row. The report is the record: a
 * `created` volume line names the target it copied into. The verdict has to be
 * about whether the data is there, not about how the last attempt went.
 */
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

/**
 * Clear the marker because the data IS here now - a second copy that worked, or a
 * factory reset that made the empty volume the intended state. Same
 * no-gate/no-throw contract as {@link markDataCopyFailed}.
 */
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
    // Deliberately swallowed: see above.
  }
}

/**
 * "Deploy anyway": the owner accepts starting without the data that did not
 * arrive, and the block goes.
 */
export async function acceptDataCopyLoss(
  target: DataCopyTarget,
): Promise<void> {
  const user = (await getCurrentUser())!;
  if (target.kind === "app") {
    const { membership } = await requireAppCapability(target.id, "deploy_apps");
    const [row] = await getDb()
      .update(appsTable)
      .set({ dataCopyError: "", updatedAt: nowIso() })
      .where(
        and(
          eq(appsTable.id, target.id),
          eq(appsTable.teamId, membership.teamId),
        ),
      )
      .returning({ name: appsTable.name });
    if (!row) throw new Error("App not found");
    await recordActivity(
      "app",
      `Deployed ${row.name} without the data a migration could not copy`,
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
    target.id,
    teamId,
  );
}
