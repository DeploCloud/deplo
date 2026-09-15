import { Lock } from "lucide-react";
import { listAllAppEnv } from "@/lib/data/env";
import { listAppliedSharedVarsByApp } from "@/lib/data/shared-vars/app-view";
import { listSharedVarTeams } from "@/lib/data/shared-vars/authoring";
import { listSharedVars } from "@/lib/data/shared-vars/team-view";
import type { AppliedSharedVarDTO } from "@/lib/data/shared-vars/app-view";
import { listProjects } from "@/lib/data/projects/read";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";
import { VariablesTabs } from "@/components/env/variables-tabs";
import { AllAppsEnvManager } from "@/components/env/all-apps-env-manager";
import { SharedVarsManager } from "@/components/env/shared-vars-manager";

export const metadata = { title: "Environment Variables" };

export default async function VariablesPage(
  props: PageProps<"/[team]/variables">,
) {
  const { edit: editParam } = await props.searchParams;
  const openEditId = Array.isArray(editParam) ? editParam[0] : editParam;
  const wholeTeam = await reachesWholeTeam();

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
    wholeTeam ? listSharedVars() : Promise.resolve([]),
    wholeTeam ? listAppliedSharedVarsByApp() : Promise.resolve([]),
    listProjects(),
    listAllEnvironmentsForTeam(),
    wholeTeam ? listSharedVarTeams() : Promise.resolve([]),
  ]);

  const sharedByApp: Record<string, AppliedSharedVarDTO[]> = {};
  for (const s of appliedShared) (sharedByApp[s.appId] ??= []).push(s);
  const projects = projectSummaries.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    color: p.color ?? null,
    appCount: p.appCount,
    environmentCount: p.environmentCount,
  }));
  const apps = allAppGroups.map((g) => g.app);

  return (
    <VariablesTabs
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
