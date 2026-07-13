import { Lock } from "lucide-react";
import { listAllAppEnv } from "@/lib/data/env";
import { listSharedVars, listAppliedSharedVarsByApp } from "@/lib/data/shared-vars";
import type { AppliedSharedVarDTO } from "@/lib/data/shared-vars";
import { listInstanceEnv } from "@/lib/data/global-env";
import { listProjects } from "@/lib/data/projects";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { AllAppsEnvManager } from "@/components/env/all-apps-env-manager";
import { SharedVarsManager } from "@/components/env/shared-vars-manager";
import { GlobalEnvManager } from "@/components/env/global-env-manager";

export const metadata = { title: "Environment Variables" };

export default async function VariablesPage(props: PageProps<"/variables">) {
  const { tab: tabParam } = await props.searchParams;
  const rawTab = Array.isArray(tabParam) ? tabParam[0] : tabParam;

  // Env values are gated by manage_env. The sidebar link is hidden without it;
  // guard the page too for direct navigation.
  if (!(await hasCapability("manage_env"))) {
    return (
      <div className="space-y-6">
        <PageHeader title="Variables" description="App & shared environment variables." />
        <EmptyState
          icon={Lock}
          title="No access to variables"
          description="You don't have permission to view environment variables. Ask a team admin for the “Manage env vars” permission."
        />
      </div>
    );
  }

  const admin = await isInstanceAdmin();
  const [
    allAppGroups,
    sharedVars,
    appliedShared,
    projectSummaries,
    teamEnvironments,
    instanceGlobals,
    canManageTeam,
  ] = await Promise.all([
    listAllAppEnv(),
    listSharedVars(),
    listAppliedSharedVarsByApp(),
    listProjects(),
    listAllEnvironmentsForTeam(),
    // Instance-wide vars are admin-only; skip the (throwing) read otherwise.
    admin ? listInstanceEnv() : Promise.resolve([]),
    hasCapability("manage_team"),
  ]);
  // The project order this page drags is the TEAM-WIDE one the Overview grid
  // shows, so it takes the same super-user gate `reorderProjects` enforces.
  const canReorderProjects = admin || canManageTeam;

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
  // team, not just the ones that hold variables — and listAllAppEnv already
  // returns a group per app (name-sorted), so there is nothing more to fetch.
  const apps = allAppGroups.map((g) => g.app);

  // Two team-facing tabs (All / Shared) + an admin-only instance tab. Legacy
  // deep links (?tab=service|environments|team) fold gracefully into the new set.
  const legacy: Record<string, string> = {
    service: "app",
    environments: "app",
    team: "app",
  };
  const tab = rawTab ? (legacy[rawTab] ?? rawTab) : "app";
  const allowedTabs = new Set(["app", "shared", ...(admin ? ["instance"] : [])]);
  const defaultTab = allowedTabs.has(tab) ? tab : "app";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Environment Variables"
        description="Per-app variables and reusable shared variables across your workspace."
      />

      {/* `key` forces a remount when ?tab= changes: Radix Tabs is uncontrolled, so
          a soft-navigation (the "Manage" links → ?tab=shared) would otherwise keep
          the old panel and the click would appear to do nothing. */}
      <Tabs key={defaultTab} defaultValue={defaultTab}>
        <UnderlineTabsList>
          {/* The value stays `app` — it is what every ?tab= deep link carries. */}
          <UnderlineTabsTrigger value="app">All</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="shared">Shared</UnderlineTabsTrigger>
          {admin && (
            <UnderlineTabsTrigger value="instance">All teams</UnderlineTabsTrigger>
          )}
        </UnderlineTabsList>

        {/* All: every app's variables (standalone + applied shared), editable */}
        <TabsContent value="app" className="space-y-4">
          <AllAppsEnvManager
            groups={allAppGroups}
            sharedByApp={sharedByApp}
            sharedVars={sharedVars}
            apps={apps}
            projects={projects}
            environments={teamEnvironments}
            canReorderProjects={canReorderProjects}
          />
        </TabsContent>

        {/* Shared: individual shared variables + their sharing modes */}
        <TabsContent value="shared">
          <SharedVarsManager
            vars={sharedVars}
            apps={apps}
            projects={projects}
            environments={teamEnvironments}
          />
        </TabsContent>

        {/* All teams: instance-wide, admin only */}
        {admin && (
          <TabsContent value="instance">
            <GlobalEnvManager scope="instance" vars={instanceGlobals} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
