import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarApps as appJunction,
} from "../../db/schema/control-plane/env-vars";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { reachesWholeTeam } from "../../membership";
import { recordActivity } from "../activity";
import { markPendingChanges } from "../pending-changes";
import { requireAppCapability } from "../node-access";
import {
  appPlacement,
  loadVisibleToTeam,
  reachableFromApp,
  visibleTo,
} from "./visibility";

async function linkableFromApp(
  varId: string,
  appId: string,
  teamId: string,
): Promise<boolean> {
  const { projectId, environmentId } = await appPlacement(appId);
  const v = (await loadVisibleToTeam(teamId)).find((x) => x.id === varId);
  return (
    v != null &&
    reachableFromApp(v, {
      appId,
      teamId,
      projectId,
      environmentId,
    })
  );
}

export async function setSharedVarAppLink(
  varId: string,
  appId: string,
  linked: boolean,
): Promise<void> {
  const { teamId, userId } = await requireAppCapability(appId, "manage_env");
  const user = (await getCurrentUser())!;
  const v = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, varId), visibleTo(teamId)))
    .limit(1);
  if (!v[0]) throw new Error("Variable not found");
  if (
    !(await reachesWholeTeam()) &&
    !(await linkableFromApp(varId, appId, teamId))
  )
    throw new Error("Variable not found");
  if (linked) {
    await getDb()
      .insert(appJunction)
      .values({ varId, appId })
      .onConflictDoNothing();
  } else {
    await getDb()
      .delete(appJunction)
      .where(and(eq(appJunction.varId, varId), eq(appJunction.appId, appId)));
  }
  await getDb()
    .update(varsTable)
    .set({ updatedByUserId: userId, updatedAt: nowIso() })
    .where(eq(varsTable.id, varId));
  await markPendingChanges([appId]);
  await recordActivity(
    "env",
    `${linked ? "Linked" : "Unlinked"} shared variable ${v[0].key}`,
    user.name,
    appId,
  );
}
