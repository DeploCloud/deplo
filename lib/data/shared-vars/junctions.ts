import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import type { DbTx } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  sharedEnvVarTargets as targetsTable,
  sharedEnvVarEnvironments as envJunction,
  sharedEnvVarProjects as projJunction,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../../db/schema/control-plane/env-vars";
import type { EnvTarget } from "../../types/env";

export async function replaceTargets(
  tx: DbTx,
  varId: string,
  targets: EnvTarget[] | null,
): Promise<void> {
  if (!targets) return;
  await tx.delete(targetsTable).where(eq(targetsTable.varId, varId));
  if (targets.length > 0)
    await tx
      .insert(targetsTable)
      .values(targets.map((target) => ({ varId, target })));
}

export async function insertScopeChildren(
  tx: DbTx,
  varId: string,
  environmentIds: string[],
  projectIds: string[],
): Promise<void> {
  if (environmentIds.length > 0)
    await tx
      .insert(envJunction)
      .values(
        environmentIds.map((environmentId) => ({ varId, environmentId })),
      );
  if (projectIds.length > 0)
    await tx
      .insert(projJunction)
      .values(projectIds.map((projectId) => ({ varId, projectId })));
}

export async function replaceTeams(
  tx: DbTx,
  varId: string,
  teamIds: string[],
): Promise<void> {
  await tx.delete(teamJunction).where(eq(teamJunction.varId, varId));
  if (teamIds.length > 0)
    await tx
      .insert(teamJunction)
      .values(teamIds.map((teamId) => ({ varId, teamId })));
}

export async function replaceAppLinks(
  tx: DbTx,
  varId: string,
  appIds: string[] | undefined,
  storedLinks: string[],
): Promise<void> {
  if (!appIds) return;
  if (storedLinks.length > 0)
    await tx
      .delete(appJunction)
      .where(
        and(
          eq(appJunction.varId, varId),
          inArray(appJunction.appId, storedLinks),
        ),
      );
  if (appIds.length > 0)
    await tx
      .insert(appJunction)
      .values(appIds.map((appId) => ({ varId, appId })));
}

// Scoped by the APP's team: counting a receiving team's opt-in made the owner's own save ask for manage_env elsewhere.
export async function currentAppLinks(
  teamId: string,
  varId: string | undefined,
): Promise<string[]> {
  if (!varId) return [];
  const rows = await getDb()
    .select({ appId: appJunction.appId })
    .from(appJunction)
    .innerJoin(appsTable, eq(appsTable.id, appJunction.appId))
    .where(and(eq(appJunction.varId, varId), eq(appsTable.teamId, teamId)));
  return rows.map((r) => r.appId);
}

export async function currentReach(varId: string | undefined): Promise<{
  teams: string[];
  environments: string[];
  projects: string[];
}> {
  if (!varId) return { teams: [], environments: [], projects: [] };
  const db = getDb();
  const [teams, environments, projects] = await Promise.all([
    db
      .select({ id: teamJunction.teamId })
      .from(teamJunction)
      .where(eq(teamJunction.varId, varId)),
    db
      .select({ id: envJunction.environmentId })
      .from(envJunction)
      .where(eq(envJunction.varId, varId)),
    db
      .select({ id: projJunction.projectId })
      .from(projJunction)
      .where(eq(projJunction.varId, varId)),
  ]);
  return {
    teams: teams.map((r) => r.id),
    environments: environments.map((r) => r.id),
    projects: projects.map((r) => r.id),
  };
}
