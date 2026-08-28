import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listEnv } from "@/lib/data/env";
import { hasAppCapability } from "@/lib/data/node-access";
import {
  listSharedVars,
  listSharedVarsForApp,
  listSharedVarTeams,
} from "@/lib/data/shared-vars";
import { listProjects } from "@/lib/data/projects";
import { composeDeclaredEnvKeys } from "@/lib/deploy/compose-stack";
import { listAllEnvironmentsForTeam } from "@/lib/data/environments";
import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { listPreviewEnvVars } from "@/lib/data/previews";
import { EnvManager } from "@/components/env/env-manager";
import { PreviewOverrides } from "@/components/env/preview-overrides";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Environment Variables" };

export default async function AppEnvPage(
  props: PageProps<"/apps/[slug]/environment">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The team's shared library is a team-wide read on BOTH axes: the capability
  // has to be held team-wide, and the caller has to reach the whole team. A
  // scoped role keeps `manage_env` on its own apps and loses the library.
  const teamWideEnv =
    (await hasCapability("manage_env")) && (await reachesWholeTeam());

  // Viewing env values requires manage_env ON THIS APP - it can be held here and
  // nowhere else (ADR-0016). Without it the tab is hidden, but guard the page too
  // in case of a direct link / stale navigation.
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
  ] = await Promise.all([
    listEnv(project.id),
    listSharedVarsForApp(project.id),
    // The full records back the value edit + "Shared with" chips a shared row now
    // exposes here; narrow to the ones this app actually receives.
    teamWideEnv ? listSharedVars() : Promise.resolve([]),
    // Preview overrides only mean anything once preview deployments are on.
    project.previewEnabled ? listPreviewEnvVars(project.id) : [],
    // What the "New shared variable" panel offers beyond this app itself. Read
    // only when the caller could actually create one.
    teamWideEnv ? listProjects() : Promise.resolve([]),
    teamWideEnv ? listAllEnvironmentsForTeam() : Promise.resolve([]),
    teamWideEnv ? listSharedVarTeams() : Promise.resolve([]),
  ]);
  // Same shape the Variables page hands the wizard: colour + counts, so a
  // project is recognised the way it is on the Overview.
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
      <EnvManager
        appId={project.id}
        appName={project.name}
        vars={vars}
        sharedVars={sharedVars}
        sharedVarDetails={sharedVarDetails}
        composeKeys={composeDeclaredEnvKeys(project.compose)}
        canCreateShared={teamWideEnv}
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
