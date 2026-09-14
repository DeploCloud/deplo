import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../db/schema/control-plane/env-vars";
import { nowIso } from "../ids";
import { requireAppCapability } from "./node-access";

// markPendingChanges stamps apps whose config is not live yet; not a gate, callers already checked.
export async function markPendingChanges(appIds: string[]): Promise<void> {
  if (appIds.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ pendingChangesAt: nowIso() })
    .where(inArray(appsTable.id, appIds));
}

// markPendingChangesForSharedVar stamps a var's per-app links (ADR-0012) plus its auto-inject teams.
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

// dismissPendingChanges clears the stamp without deploying.
export async function dismissPendingChanges(appId: string): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "manage_env");
  await getDb()
    .update(appsTable)
    .set({ pendingChangesAt: null })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)));
}
