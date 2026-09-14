import "server-only";

import { and, eq, exists, inArray, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  sharedEnvVars as varsTable,
  sharedEnvVarTargets as targetsTable,
  sharedEnvVarEnvironments as envJunction,
  sharedEnvVarProjects as projJunction,
  sharedEnvVarApps as appJunction,
  sharedEnvVarTeams as teamJunction,
} from "../../db/schema/control-plane/env-vars";
import type { EnvTarget, SharedVar } from "../../types/env";

// visibleTo - a team SEES a variable it owns, or one shared into it. Every READ uses
// this; a write keeps its own eq(teamId), because seeing is not editing (ADR-0027).
export function visibleTo(teamId: string) {
  return or(
    eq(varsTable.teamId, teamId),
    exists(
      getDb()
        .select({ one: teamJunction.varId })
        .from(teamJunction)
        .where(
          and(
            eq(teamJunction.varId, varsTable.id),
            eq(teamJunction.teamId, teamId),
          ),
        ),
    ),
  );
}

// loadVisibleToTeam - the variables one team SEES: owned by it, or shared into it.
export async function loadVisibleToTeam(teamId: string): Promise<SharedVar[]> {
  return stitch(
    await getDb().select().from(varsTable).where(visibleTo(teamId)),
  );
}

// visibleSharedVarIdsByKey - every shared variable the team SEES, by key.
// No auth gate: the only caller is a migration import, already gated, and it needs the
// keys a team would DUPLICATE - including one another team shared in under that name.
export async function visibleSharedVarIdsByKey(
  teamId: string,
): Promise<Map<string, string>> {
  const rows = await getDb()
    .select({ id: varsTable.id, key: varsTable.key })
    .from(varsTable)
    .where(visibleTo(teamId));
  return new Map(rows.map((r) => [r.key, r.id] as const));
}

async function stitch(
  rows: (typeof varsTable.$inferSelect)[],
): Promise<SharedVar[]> {
  const db = getDb();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [targets, envs, projs, apps, teams] = await Promise.all([
    db.select().from(targetsTable).where(inArray(targetsTable.varId, ids)),
    db.select().from(envJunction).where(inArray(envJunction.varId, ids)),
    db.select().from(projJunction).where(inArray(projJunction.varId, ids)),
    db.select().from(appJunction).where(inArray(appJunction.varId, ids)),
    db.select().from(teamJunction).where(inArray(teamJunction.varId, ids)),
  ]);
  const group = <T, V>(list: T[], key: (t: T) => string, val: (t: T) => V) => {
    const m = new Map<string, V[]>();
    for (const item of list) {
      const k = key(item);
      const arr = m.get(k) ?? [];
      arr.push(val(item));
      m.set(k, arr);
    }
    return m;
  };
  const targetsBy = group(
    targets,
    (t) => t.varId,
    (t) => t.target as EnvTarget,
  );
  const envsBy = group(
    envs,
    (e) => e.varId,
    (e) => e.environmentId,
  );
  const projsBy = group(
    projs,
    (p) => p.varId,
    (p) => p.projectId,
  );
  const appsBy = group(
    apps,
    (a) => a.varId,
    (a) => a.appId,
  );
  const teamsBy = group(
    teams,
    (t) => t.varId,
    (t) => t.teamId,
  );
  return rows.map((r) => ({
    id: r.id,
    teamId: r.teamId,
    key: r.key,
    valueEnc: r.valueEnc,
    type: r.type as "plain" | "secret",
    teamIds: teamsBy.get(r.id) ?? [],
    autoInject: r.autoInject,
    environmentIds: envsBy.get(r.id) ?? [],
    projectIds: projsBy.get(r.id) ?? [],
    appIds: appsBy.get(r.id) ?? [],
    targets: targetsBy.get(r.id) ?? [],
    createdByUserId: r.createdByUserId,
    updatedByUserId: r.updatedByUserId,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

// appPlacement - the project and environment an app sits in, for the reachability test.
export async function appPlacement(appId: string): Promise<{
  projectId: string | null;
  environmentId: string | null;
}> {
  const app = (
    await getDb()
      .select({
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
      .limit(1)
  )[0];
  return {
    projectId: app?.projectId ?? null,
    environmentId: app?.environmentId ?? null,
  };
}

// reachableFromApp - whether one shared var pertains to one app: linked to it, or
// suggested by a project or environment the app lives in.
export function reachableFromApp(
  v: {
    appIds: string[];
    projectIds: string[];
    environmentIds: string[];
    autoInject: boolean;
    teamIds: string[];
  },
  app: {
    appId: string;
    teamId: string;
    projectId: string | null;
    environmentId: string | null;
  },
): boolean {
  return (
    v.appIds.includes(app.appId) ||
    (app.projectId != null && v.projectIds.includes(app.projectId)) ||
    (app.environmentId != null &&
      v.environmentIds.includes(app.environmentId)) ||
    // A variable that lands in this container with no link of its own must not be
    // invisible to the one person allowed to see the app's variables. A team-wide one
    // that does NOT auto-inject stays hidden on purpose - see authz-escape.test.
    (v.autoInject && v.teamIds.includes(app.teamId))
  );
}
