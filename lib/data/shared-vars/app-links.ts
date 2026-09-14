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

// The write-side twin of the filter in `listSharedVarsForApp`: may a narrowed caller
// name this variable from this app at all?
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

// setSharedVarAppLink - attach or detach one shared var to one app (idempotent).
export async function setSharedVarAppLink(
  varId: string,
  appId: string,
  linked: boolean,
): Promise<void> {
  const { teamId, userId } = await requireAppCapability(appId, "manage_env");
  const user = (await getCurrentUser())!;
  // Visible, not owned: attaching a variable another team shared with us is THIS
  // team's opt-in, not an edit of their row (ADR-0027).
  const v = await getDb()
    .select({ key: varsTable.key })
    .from(varsTable)
    .where(and(eq(varsTable.id, varId), visibleTo(teamId)))
    .limit(1);
  if (!v[0]) throw new Error("Variable not found");
  // Belonging to the team is not enough for a NARROWED caller. Same message as an
  // unknown id: a scope must never say which ids exist.
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
  // Linking is a scope change, so it IS a modification: stamp the author too -
  // "Last modified" must never show a timestamp with nobody behind it.
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
