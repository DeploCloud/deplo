import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";
import { recordActivity } from "./activity";
import { getCurrentUser } from "../auth";
import { requireCapability } from "../membership";
import { requireAppCapability } from "./node-access";

/**
 * The one column that says "this workload's data did not arrive", and the
 * refusal every way of starting it goes through.
 *
 * A cross-host copy is wipe-first: the destination volume is emptied before the
 * tar is extracted into it, so a copy that dies mid-stream does not leave the old
 * contents behind - it leaves nothing, or half of something. That is worse than a
 * copy that never started, and it does not look like a failure from the outside:
 * a database engine handed an empty data directory INITIALISES a new one, and an
 * app that version-checks a file on disk decides it is a fresh install. Both write
 * over the place the real data was meant to be, and both report success.
 *
 * So the message is kept on the row, and Deploy, Start, Restart and Redeploy all
 * refuse while it is there. The refusal is not a permission and not an error the
 * platform can resolve on its own: it is a decision waiting for the person who
 * ran the migration, and it names both ways out.
 */

/** What a refused start says, everywhere it is refused. */
export function assertDataCopyIntact(
  name: string,
  dataCopyError: string,
): void {
  if (!dataCopyError) return;
  throw new Error(
    `${name}'s data did not come across: ${dataCopyError}. Starting it now would ` +
      `run it on empty storage. Copy the data again from Settings → Migrations, ` +
      `or choose "Deploy anyway" on its page to accept starting without it.`,
  );
}

/** Which of the two tables a marker lives on. */
export type DataCopyTarget = { kind: "app" | "database"; id: string };

/**
 * Record why a copy did not land, on the row itself.
 *
 * Called by the import's copy step, which is already gated - this is the tail of
 * an action someone was allowed to take, not an action of its own. It never
 * throws: a marker that could not be written must not turn one failed volume into
 * a failed import, and the report line is written either way.
 */
export async function markDataCopyFailed(
  target: DataCopyTarget,
  message: string,
): Promise<void> {
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
 *
 * It has to exist. The alternative is an app that can never be deployed again
 * because the machine it was migrated from has since been turned off - which is
 * the normal end of a migration. The capability is the one that would have
 * deployed it anyway, the choice goes in the Activity trail with the reason it
 * overrode, and the marker is cleared team-scoped like every other row-targeting
 * write.
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
