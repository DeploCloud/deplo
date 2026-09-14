import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { listEnv, listEnvManageableApps } from "@/lib/data/env";
import { hasAppCapability } from "@/lib/data/node-access";
import { listSharedVarsForApp } from "@/lib/data/shared-vars/app-view";
import { listSharedVarTeams } from "@/lib/data/shared-vars/authoring";
import { listSharedVars } from "@/lib/data/shared-vars/team-view";
import { listProjects } from "@/lib/data/projects/read";
import { composeDeclaredEnvKeys } from "@/lib/deploy/compose-stack/compose-read";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { listPreviewEnvVars } from "@/lib/data/previews";
import { EnvManager } from "@/components/env/env-manager";
import { PendingChangesNotice } from "@/components/apps/pending-changes-notice";
import { PreviewOverrides } from "@/components/env/preview-overrides";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Environment Variables" };

export default async function AppEnvPage(
  props: PageProps<"/[team]/apps/[slug]/environment">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // Team-wide on BOTH axes: a scoped role keeps `manage_env` on its own apps and loses the library.
  const teamWideEnv =
    (await hasCapability("manage_env")) && (await reachesWholeTeam());

  // manage_env must be held ON THIS APP (ADR-0016); the hidden tab is still reachable by direct link.
  if (!(await hasAppCapability(project.id, "manage_env"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to environment variables"
        docs="roles.floorCeiling"
        description="You don't have permission to view this app's environment variables. Ask a team admin for the “Manage env vars” permission."
      />
    );
  }

  const [
    vars,
    sharedVars,
    allSharedVars,
    previewOverrides,
    projectSummaries,
    environments,
    shareableTeams,
    teamApps,
  ] = await Promise.all([
    listEnv(project.id),
    listSharedVarsForApp(project.id),
    teamWideEnv ? listSharedVars() : Promise.resolve([]),
    project.previewEnabled ? listPreviewEnvVars(project.id) : [],
    teamWideEnv ? listProjects() : Promise.resolve([]),
    teamWideEnv ? listAllEnvironmentsForTeam() : Promise.resolve([]),
    teamWideEnv ? listSharedVarTeams() : Promise.resolve([]),
    teamWideEnv ? listEnvManageableApps() : Promise.resolve([]),
  ]);
  // Same shape the Variables page hands the wizard, so a project reads as it does on the Overview.
  const projects = projectSummaries.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    color: p.color ?? null,
    appCount: p.appCount,
    environmentCount: p.environmentCount,
  }));
  const linkedIds = new Set(
    sharedVars.filter((v) => v.linked).map((v) => v.id),
  );
  const sharedVarDetails = allSharedVars.filter((v) => linkedIds.has(v.id));

  return (
    <div className="space-y-6">
      <PendingChangesNotice
        appId={project.id}
        slug={project.slug}
        pendingChangesAt={project.pendingChangesAt ?? null}
        neverDeployed={project.latestDeploymentId == null}
      />
      <EnvManager
        appId={project.id}
        vars={vars}
        sharedVars={sharedVars}
        sharedVarDetails={sharedVarDetails}
        composeKeys={composeDeclaredEnvKeys(project.compose)}
        canCreateShared={teamWideEnv}
        apps={teamApps}
        projects={projects}
        environments={environments}
        teams={shareableTeams}
      />
      {project.previewEnabled && (
        <PreviewOverrides appId={project.id} overrides={previewOverrides} />
      )}
    </div>
  );
}
