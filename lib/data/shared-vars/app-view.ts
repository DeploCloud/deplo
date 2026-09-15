import "server-only";

import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  reachesWholeTeam,
  requireCapability,
  requireMembership,
  requireTeamWide,
} from "../../membership";
import { appCapabilitiesForTeam, hasAppCapability } from "../node-access";
import { authorOf, loadUserIdentities } from "../user-identity";
import { sanitizeTargets } from "../../types/env";
import type { EnvTarget } from "../../types/env";
import type { VarAuthor } from "../../types/identity";
import {
  appPlacement,
  loadVisibleToTeam,
  reachableFromApp,
} from "./visibility";
import { authorIds, shownValue, teamNames } from "./display";

export type SharedVarScope = "teamWide" | "environment" | "project";

function scopeFor(m: {
  byOwnEnv: boolean;
  byProject: boolean;
  teamWide: boolean;
}): SharedVarScope | null {
  if (m.byOwnEnv) return "environment";
  if (m.byProject) return "project";
  if (m.teamWide) return "teamWide";
  return null;
}

export interface AppSharedVarDTO {
  id: string;
  key: string;
  value: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  linked: boolean;
  inScope: boolean;
  autoInject: boolean;
  ownerTeamName: string | null;
  scope: SharedVarScope | null;
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

export async function listSharedVarsForApp(
  appId: string,
): Promise<AppSharedVarDTO[]> {
  const { teamId } = await requireMembership();
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const { projectId, environmentId } = await appPlacement(appId);
  const all = await loadVisibleToTeam(teamId);
  const vars = (await reachesWholeTeam())
    ? all
    : all.filter((v) =>
        reachableFromApp(v, { appId, teamId, projectId, environmentId }),
      );
  const [authors, teams] = await Promise.all([
    loadUserIdentities(authorIds(vars)),
    teamNames(vars),
  ]);
  return vars
    .map((v) => {
      const byProject = projectId != null && v.projectIds.includes(projectId);
      const byOwnEnv =
        environmentId != null && v.environmentIds.includes(environmentId);
      const linked = v.appIds.includes(appId);
      const teamWide = v.teamIds.includes(teamId);
      const inScope = teamWide || byProject || byOwnEnv;
      return {
        id: v.id,
        key: v.key,
        value: shownValue(v),
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        linked,
        inScope,
        autoInject: v.autoInject && teamWide,
        ownerTeamName: v.teamId ? (teams.get(v.teamId)?.name ?? null) : null,
        scope: scopeFor({ byOwnEnv, byProject, teamWide }),
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

export interface AppliedSharedVarDTO {
  appId: string;
  id: string;
  key: string;
  value: string;
  masked: boolean;
  targets: EnvTarget[];
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

export async function listAppliedSharedVarsByApp(): Promise<
  AppliedSharedVarDTO[]
> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const vars = await loadVisibleToTeam(teamId);
  const authors = await loadUserIdentities(authorIds(vars));
  const linkedAppIds = [...new Set(vars.flatMap((v) => v.appIds))];
  const appRows = linkedAppIds.length
    ? await getDb()
        .select({
          id: appsTable.id,
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(
          and(
            inArray(appsTable.id, linkedAppIds),
            eq(appsTable.teamId, teamId),
          ),
        )
    : [];
  const reach = await appCapabilitiesForTeam(teamId, appRows);
  const shown = new Map(vars.map((v) => [v.id, shownValue(v)] as const));
  const out: AppliedSharedVarDTO[] = [];
  for (const v of vars) {
    for (const appId of v.appIds) {
      if (!reach.get(appId)?.includes("manage_env")) continue;
      out.push({
        appId,
        id: v.id,
        key: v.key,
        value: shown.get(v.id)!,
        masked: v.type === "secret",
        targets: sanitizeTargets(v.targets),
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      });
    }
  }
  return out;
}
