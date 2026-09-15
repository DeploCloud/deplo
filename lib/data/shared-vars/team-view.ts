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
  value: string;
  masked: boolean;
  type: "plain" | "secret";
  targets: EnvTarget[];
  teamWide: boolean;
  teamIds: string[];
  teams: SharedVarTeamRef[];
  autoInject: boolean;
  ownerTeam: SharedVarTeamRef | null;
  editable: boolean;
  environmentIds: string[];
  projectIds: string[];
  appIds: string[];
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
      const environmentIds = editable ? v.environmentIds : [];
      const projectIds = editable ? v.projectIds : [];
      const appIds = editable ? v.appIds : [];
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
        createdBy: authorOf(v.createdByUserId, authors),
        updatedBy: authorOf(v.updatedByUserId, authors),
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });
}
