// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Lock } from "lucide-react";
import { listAllAppEnv } from "@/lib/data/env";
import {
  listSharedVars,
  listAppliedSharedVarsByApp,
  listSharedVarTeams,
} from "@/lib/data/shared-vars";
import type { AppliedSharedVarDTO } from "@/lib/data/shared-vars";
import { listProjects } from "@/lib/data/projects";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { VariablesTabs } from "@/components/env/variables-tabs";
import { AllAppsEnvManager } from "@/components/env/all-apps-env-manager";
import { SharedVarsManager } from "@/components/env/shared-vars-manager";

export const metadata = { title: "Environment Variables" };

export default async function VariablesPage(props: PageProps<"/variables">) {
  const { edit: editParam } = await props.searchParams;
  const openEditId = Array.isArray(editParam) ? editParam[0] : editParam;
  const wholeTeam = await reachesWholeTeam();

  // Env values are gated by manage_env. The sidebar link is hidden without it;
  // guard the page too for direct navigation.
  if (!(await hasCapability("manage_env"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to variables"
        docs="roles.floorCeiling"
        description="You don't have permission to view environment variables. Ask a team admin for the “Manage env vars” permission."
      />
    );
  }

  const [
    allAppGroups,
    sharedVars,
    appliedShared,
    projectSummaries,
    teamEnvironments,
    shareableTeams,
  ] = await Promise.all([
    listAllAppEnv(),
    // The team's shared library is a team-wide read: a member limited to part of
    // the team keeps the per-app tab and loses the library, rather than losing
    // the page. Same shape the Storage and app Environment pages already use.
    wholeTeam ? listSharedVars() : Promise.resolve([]),
    wholeTeam ? listAppliedSharedVarsByApp() : Promise.resolve([]),
    listProjects(),
    listAllEnvironmentsForTeam(),
    // The teams the wizard may offer: the viewer's own, minus the ones where they
    // do not hold manage_env across the whole team.
    wholeTeam ? listSharedVarTeams() : Promise.resolve([]),
  ]);

  const sharedByApp: Record<string, AppliedSharedVarDTO[]> = {};
  for (const s of appliedShared) (sharedByApp[s.appId] ??= []).push(s);
  // The wizard's project cards carry the container's colour + counts, so a
  // project is recognised the same way it is on the Overview.
  const projects = projectSummaries.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    color: p.color ?? null,
    appCount: p.appCount,
    environmentCount: p.environmentCount,
  }));
  // The shared-var wizard's "specific apps" scope needs every app in the active
  // team, not just the ones that hold variables, and listAllAppEnv already
  // returns a group per app (name-sorted), so there is nothing more to fetch.
  const apps = allAppGroups.map((g) => g.app);

  return (
    <VariablesTabs
      // All: every app's variables (standalone + applied shared), editable
      all={
        <AllAppsEnvManager
          groups={allAppGroups}
          sharedByApp={sharedByApp}
          sharedVars={sharedVars}
          apps={apps}
          projects={projects}
          environments={teamEnvironments}
          teams={shareableTeams}
        />
      }
      // Shared: individual shared variables + their sharing modes
      shared={
        <SharedVarsManager
          vars={sharedVars}
          openEditId={openEditId}
          apps={apps}
          projects={projects}
          environments={teamEnvironments}
          teams={shareableTeams}
        />
      }
    />
  );
}
