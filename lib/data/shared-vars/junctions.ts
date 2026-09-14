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

// replaceTargets - whole-set replace, but ONLY when the caller sent a set: `null` leaves
// the stored targets untouched (see `saveSharedVar`).
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

// insertScopeChildren - whole-set replace of a var's environment/project junctions.
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

// replaceTeams - whole-set replace of the team-reach junction.
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

// replaceAppLinks - whole-set replace of the per-app links, but ONLY when the caller
// sent a set: `undefined` leaves the junction untouched (see `saveSharedVar`).
export async function replaceAppLinks(
  tx: DbTx,
  varId: string,
  appIds: string[] | undefined,
  // The acting team's stored links - the ONLY rows this replace may delete.
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

// currentAppLinks - the var's per-app links IN THE ACTING TEAM. Scoped by the APP's team,
// never the variable's owner: counting a receiving team's opt-in here made the owner's
// own save ask for `manage_env` on an app in another team, and be refused forever.
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

// currentReach - what a stored variable reaches now (all empty for one not yet created).
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
