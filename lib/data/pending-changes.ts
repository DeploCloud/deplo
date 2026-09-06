import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  sharedEnvVars as varsTable,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../db/schema/control-plane";
import { nowIso } from "../ids";

/**
 * Stamp apps whose saved config is not live yet. Not a gate: every caller has
 * already passed its own capability check, and the stamp only drives a banner.
 */
export async function markPendingChanges(appIds: string[]): Promise<void> {
  if (appIds.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ pendingChangesAt: nowIso() })
    .where(inArray(appsTable.id, appIds));
}

/**
 * The apps one shared variable reaches: its per-app links (ADR-0012), plus every
 * app of every team it auto-injects into.
 */
export async function markPendingChangesForSharedVar(
  varId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(appsTable)
    .set({ pendingChangesAt: nowIso() })
    .where(
      inArray(
        appsTable.id,
        db
          .select({ id: appJunction.appId })
          .from(appJunction)
          .where(eq(appJunction.varId, varId)),
      ),
    );
  const auto = await db
    .select({ autoInject: varsTable.autoInject })
    .from(varsTable)
    .where(eq(varsTable.id, varId))
    .limit(1);
  if (!auto[0]?.autoInject) return;
  await db
    .update(appsTable)
    .set({ pendingChangesAt: nowIso() })
    .where(
      inArray(
        appsTable.teamId,
        db
          .select({ id: teamJunction.teamId })
          .from(teamJunction)
          .where(eq(teamJunction.varId, varId)),
      ),
    );
}
