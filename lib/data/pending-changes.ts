import "server-only";

import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../db/schema/control-plane/env-vars";
import { nowIso } from "../ids";
import { requireAppCapability } from "./node-access";

/** A cluster App's variables reach its other servers now, not at its next deploy. */
async function followOnCluster(appIds: string[] | "all"): Promise<void> {
  const onCluster = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(
      appIds === "all"
        ? isNotNull(appsTable.clusterId)
        : and(inArray(appsTable.id, appIds), isNotNull(appsTable.clusterId)),
    );
  if (onCluster.length === 0) return;
  const { followAppEnvSoon } = await import("./clusters/env-follow");
  for (const a of onCluster) followAppEnvSoon(a.id);
}

export async function markPendingChanges(appIds: string[]): Promise<void> {
  if (appIds.length === 0) return;
  await getDb()
    .update(appsTable)
    .set({ pendingChangesAt: nowIso() })
    .where(inArray(appsTable.id, appIds));
  await followOnCluster(appIds);
}

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
  // Which Apps a shared variable reaches is the resolver's to say: each cluster App compares its own.
  await followOnCluster("all");
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

export async function dismissPendingChanges(appId: string): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "manage_env");
  await getDb()
    .update(appsTable)
    .set({ pendingChangesAt: null })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)));
}
