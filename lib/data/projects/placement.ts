import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  projects as projectsTable,
  environments as environmentsTable,
} from "../../db/schema/control-plane/projects";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import { currentMemberScope } from "../../membership";
import { recordActivity } from "../activity";
import { reapplyNetworkAfterMove } from "../../deploy/build/reroute";
import { lostNeighbourMessage, neighboursLostByMove } from "../reachability";
import { assertNoNameClash, withNetworkLock } from "../name-clash";
import { composeNamesOnNetwork } from "../../deploy/compose-stack/compose-read";
import { stackName } from "../../deploy/deploy-key";
import { requireAppCapability } from "../node-access";
import { inProjectScope } from "../../auth/request-context";
import { appInScope } from "../node-scope";
import { assertContainerNotMigrating } from "../migration-guard";

export async function defaultEnvironmentFor(
  projectId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await getDb()
    .select({
      id: environmentsTable.id,
      name: environmentsTable.name,
      isDefault: environmentsTable.isDefault,
      position: environmentsTable.position,
    })
    .from(environmentsTable)
    .where(eq(environmentsTable.projectId, projectId));
  if (rows.length === 0) return null;
  const def =
    rows.find((e) => e.isDefault) ??
    [...rows].sort((a, b) => a.position - b.position)[0];
  return { id: def.id, name: def.name };
}

export async function moveAppToProject(
  appId: string,
  projectId: string | null,
): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "move_apps");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const s = (
    await getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        projectId: appsTable.projectId,
      })
      .from(appsTable)
      .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!s) throw new Error("App not found");
  if ((s.projectId ?? null) === projectId) return;
  if (
    !appInScope(await currentMemberScope(), {
      id: appId,
      folderId: null,
      projectId,
      environmentId: null,
    })
  )
    throw new Error(
      projectId
        ? "Project not found"
        : "Your role only reaches part of this team, so an app can't be moved out of it.",
    );
  let msg: string;
  let environmentId: string | null = null;
  if (projectId) {
    const p = (
      await getDb()
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(
          and(
            eq(projectsTable.id, projectId),
            eq(projectsTable.teamId, teamId),
          ),
        )
        .limit(1)
    )[0];
    if (!p || !inProjectScope(projectId)) throw new Error("Project not found");
    await assertContainerNotMigrating("project", projectId);
    const env = await defaultEnvironmentFor(projectId);
    environmentId = env?.id ?? null;
    msg = env
      ? `Moved ${s.name} into project ${p.name} (${env.name})`
      : `Moved ${s.name} into project ${p.name}`;
  } else {
    msg = `Moved ${s.name} out of its project`;
  }
  await withNetworkLock({ teamId, environmentId }, async () => {
    await assertAppNamesFreeAt(appId, teamId, environmentId);
    await getDb()
      .update(appsTable)
      .set({
        projectId,
        environmentId,
        ...(projectId ? { folderId: null } : {}),
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, appId));
  });
  await reapplyNetworkAfterMove([appId]);
  await warnLostNeighbours(appId, s.name, { teamId, environmentId });
  await recordActivity("project", msg, userName, appId, teamId);
}

export async function moveAppToEnvironment(
  appId: string,
  environmentId: string,
): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "move_apps");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const s = (
    await getDb()
      .select({
        id: appsTable.id,
        name: appsTable.name,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!s) throw new Error("App not found");
  if ((s.environmentId ?? null) === environmentId) return;
  const env = (
    await getDb()
      .select({
        id: environmentsTable.id,
        name: environmentsTable.name,
        projectId: environmentsTable.projectId,
        projectName: projectsTable.name,
        teamId: projectsTable.teamId,
      })
      .from(environmentsTable)
      .innerJoin(
        projectsTable,
        eq(environmentsTable.projectId, projectsTable.id),
      )
      .where(eq(environmentsTable.id, environmentId))
      .limit(1)
  )[0];
  if (
    !env ||
    env.teamId !== teamId ||
    !inProjectScope(env.projectId) ||
    !appInScope(await currentMemberScope(), {
      id: appId,
      folderId: null,
      projectId: env.projectId,
      environmentId: env.id,
    })
  )
    throw new Error("Environment not found");
  await assertContainerNotMigrating("environment", environmentId);
  await withNetworkLock({ teamId, environmentId: env.id }, async () => {
    await assertAppNamesFreeAt(appId, teamId, env.id);
    await getDb()
      .update(appsTable)
      .set({
        projectId: env.projectId,
        environmentId: env.id,
        folderId: null,
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, appId));
  });
  await reapplyNetworkAfterMove([appId]);
  await warnLostNeighbours(appId, s.name, { teamId, environmentId: env.id });
  await recordActivity(
    "project",
    `Moved ${s.name} to ${env.name} in project ${env.projectName}`,
    userName,
    appId,
    teamId,
  );
}

async function assertAppNamesFreeAt(
  appId: string,
  teamId: string,
  environmentId: string | null,
): Promise<void> {
  const [row] = await getDb()
    .select({
      slug: appsTable.slug,
      compose: appsTable.compose,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!row) return;
  await assertNoNameClash({
    to: { teamId, environmentId, serverId: row.serverId },
    claims: row.compose?.trim()
      ? composeNamesOnNetwork(row.compose)
      : [stackName(row.slug)],
    exceptId: appId,
    subject: "this app",
  });
}

async function warnLostNeighbours(
  appId: string,
  appName: string,
  to: { teamId: string; environmentId: string | null },
): Promise<void> {
  try {
    const lost = await neighboursLostByMove(appId, to);
    if (lost.length === 0) return;
    await recordActivity(
      "app",
      lostNeighbourMessage(appName, lost),
      "Deplo",
      appId,
      to.teamId,
    );
  } catch {}
}
