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

// SharedVarScope - the layer a var is OFFERED to an app through, never the layer it
// injects through: injection is always the per-app link (ADR-0012).
export type SharedVarScope = "teamWide" | "environment" | "project";

// The most SPECIFIC availability scope covering one app; null when none does - the var
// is still linkable, because scopes are suggestions, not gates (ADR-0012).
function scopeFor(m: {
  byOwnEnv: boolean;
  byProject: boolean;
  // The var reaches THIS app's team - per viewer, not a property of the row.
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
  // Masked for secrets - a secret still has no reveal path here.
  value: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  // The app has explicitly opted in - the var injects on its next deploy.
  linked: boolean;
  // An availability scope (team-wide / environment / project) covers this app.
  inScope: boolean;
  // It lands in this app with NO link and cannot be removed here: another team shares
  // it, or an instance admin does (ADR-0027). Read-only in the app UI.
  autoInject: boolean;
  // The team that owns an auto-injected variable, for the read-only row.
  ownerTeamName: string | null;
  // The most specific covering scope; null when none does.
  scope: SharedVarScope | null;
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

// listSharedVarsForApp - every shared var of the team as seen from one app: its opt-in
// state (`linked`) and whether a scope suggests it here (`inScope`/`scope`).
export async function listSharedVarsForApp(
  appId: string,
): Promise<AppSharedVarDTO[]> {
  const { teamId } = await requireMembership();
  if (!(await hasAppCapability(appId, "manage_env"))) return [];
  const { projectId, environmentId } = await appPlacement(appId);
  const all = await loadVisibleToTeam(teamId);
  // Both principals, one rule: a narrowed token and a member on a limited role
  // reach the same part of the team, so they see the same variables.
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
      // A covering scope only SUGGESTS the var here - injection is the link, unless
      // the variable auto-injects (ADR-0027), which needs no opt-in at all.
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
        // Falls back to the creator so "Last modified" never shows a timestamp
        // with no author.
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

// AppliedSharedVarDTO - one opted-in shared var as seen on the aggregate App tab.
export interface AppliedSharedVarDTO {
  appId: string;
  id: string;
  key: string;
  // Masked for secrets, like every other variable table (see AppSharedVarDTO).
  value: string;
  masked: boolean;
  targets: EnvTarget[];
  updatedBy: VarAuthor | null;
  updatedAt: string;
}

// listAppliedSharedVarsByApp - every (app, shared var) pair that currently injects, i.e.
// every per-app LINK across the team (ADR-0012: only an explicit opt-in injects).
export async function listAppliedSharedVarsByApp(): Promise<
  AppliedSharedVarDTO[]
> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const vars = await loadVisibleToTeam(teamId);
  const authors = await loadUserIdentities(authorIds(vars));
  // Node scope, mirroring `listAllAppEnv`: a link into an app the caller can't
  // `manage_env` is dropped instead of surfacing that app's applied rows through the
  // aggregate tab (its card is filtered out there too).
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
  // A var linked to SEVERAL apps repeats below, so decrypt each value once here
  // rather than once per (app, var) pair.
  const shown = new Map(vars.map((v) => [v.id, shownValue(v)] as const));
  const out: AppliedSharedVarDTO[] = [];
  for (const v of vars) {
    for (const appId of v.appIds) {
      // A dangling/cross-team link reads as no app; an app the caller can't
      // manage_env drops the row.
      if (!reach.get(appId)?.includes("manage_env")) continue;
      out.push({
        appId,
        id: v.id,
        key: v.key,
        value: shown.get(v.id)!,
        masked: v.type === "secret",
        targets: sanitizeTargets(v.targets),
        // Falls back to the creator so "Last modified" never shows a timestamp
        // with no author.
        updatedBy: authorOf(v.updatedByUserId ?? v.createdByUserId, authors),
        updatedAt: v.updatedAt,
      });
    }
  }
  return out;
}
