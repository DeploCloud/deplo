import "server-only";

import {
  isInstanceAdmin,
  requireCapability,
  requireTeamWide,
} from "../../membership";
import { authorOf, loadUserIdentities } from "../user-identity";
import { sanitizeTargets } from "../../types/env";
import type { EnvTarget } from "../../types/env";
import type { VarAuthor } from "../../types/identity";
import { loadVisibleToTeam } from "./visibility";
import {
  authorIds,
  shownValue,
  teamLookups,
  teamNames,
  type SharedVarTeamRef,
} from "./display";

export interface SharedVarDTO {
  id: string;
  key: string;
  value: string; // masked for secrets
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  // The variable reaches the VIEWER's team - the old team-wide sharing mode.
  teamWide: boolean;
  // Every team it reaches. Two or more ⇒ it injects with no link.
  teamIds: string[];
  teams: SharedVarTeamRef[];
  // Injects into every app of every team above, with no per-app link.
  autoInject: boolean;
  // The owning team, or null when the instance owns it.
  ownerTeam: SharedVarTeamRef | null;
  // The viewer's team owns it (or an instance admin owns the instance one).
  editable: boolean;
  environmentIds: string[];
  projectIds: string[];
  appIds: string[];
  // Decorations for the Shared-tab display (names never leak secret values).
  environments: { id: string; name: string; projectName: string }[];
  projects: { id: string; name: string; slug: string }[];
  apps: { id: string; name: string; slug: string; logo: string | null }[];
  createdBy: VarAuthor | null;
  updatedBy: VarAuthor | null;
  createdAt: string;
  updatedAt: string;
}

function present<T>(x: T | undefined): x is T {
  return Boolean(x);
}

// listSharedVars - every shared variable the active team sees, key-sorted, decorated.
// A variable another team owns comes back READ-ONLY and stripped of that team's object
// graph: those ids name rows this team has no business enumerating (ADR-0027).
export async function listSharedVars(): Promise<SharedVarDTO[]> {
  await requireTeamWide("shared variables");
  const { teamId } = await requireCapability("manage_env");
  const [vars, lookups, admin] = await Promise.all([
    loadVisibleToTeam(teamId),
    teamLookups(teamId),
    isInstanceAdmin(),
  ]);
  const [authors, teams] = await Promise.all([
    loadUserIdentities(authorIds(vars)),
    teamNames(vars),
  ]);
  return vars
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((v) => {
      const editable = v.teamId === teamId || (v.teamId === null && admin);
      // A foreign variable's scopes point at ITS team's rows.
      const environmentIds = editable ? v.environmentIds : [];
      const projectIds = editable ? v.projectIds : [];
      const appIds = editable ? v.appIds : [];
      // And the ROSTER is not ours either: a team that merely receives the variable
      // is told who owns it (ADR-0027 §2), not which other teams also run on it.
      const teamIds = editable
        ? v.teamIds
        : v.teamIds.filter((id) => id === teamId);
      return {
        id: v.id,
        key: v.key,
        value: shownValue(v),
        masked: v.type === "secret",
        type: v.type,
        targets: sanitizeTargets(v.targets),
        teamWide: v.teamIds.includes(teamId),
        teamIds,
        teams: teamIds.map((id) => teams.get(id)).filter(present),
        autoInject: v.autoInject,
        ownerTeam: v.teamId ? (teams.get(v.teamId) ?? null) : null,
        editable,
        environmentIds,
        projectIds,
        appIds,
        environments: environmentIds
          .map((id) => lookups.environments.get(id))
          .filter(present),
        projects: projectIds
          .map((id) => lookups.projects.get(id))
          .filter(present),
        apps: appIds.map((id) => lookups.apps.get(id)).filter(present),
        // Authorship is metadata, not value - safe alongside a masked `value`.
        createdBy: authorOf(v.createdByUserId, authors),
        updatedBy: authorOf(v.updatedByUserId, authors),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });
}
