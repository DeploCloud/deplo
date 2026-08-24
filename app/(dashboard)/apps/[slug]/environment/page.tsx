import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { listEnv } from "@/lib/data/env";
import { hasAppCapability } from "@/lib/data/node-access";
import { listSharedVars, listSharedVarsForApp } from "@/lib/data/shared-vars";
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

  // Viewing env values requires manage_env ON THIS APP — it can be held here and
  // nowhere else (ADR-0016). Without it the tab is hidden, but guard the page too
  // in case of a direct link / stale navigation.
  if (!(await hasAppCapability(project.id, "manage_env"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to environment variables"
        description="You don't have permission to view this app's environment variables. Ask a team admin for the “Manage env vars” permission."
      />
    );
  }

  const [vars, sharedVars, allSharedVars, previewOverrides] = await Promise.all(
    [
      listEnv(project.id),
      listSharedVarsForApp(project.id),
      // The full records back the value edit + "Shared with" chips a shared row now
      // exposes here; narrow to the ones this app actually receives. Team-wide, so
      // it stays behind the TEAM capability: someone whose `manage_env` comes from
      // this app alone sees the app's own variables, not the team's library.
      teamWideEnv ? listSharedVars() : Promise.resolve([]),
      // Preview overrides only mean anything once preview deployments are on.
      project.previewEnabled ? listPreviewEnvVars(project.id) : [],
    ],
  );
  const linkedIds = new Set(
    sharedVars.filter((v) => v.linked).map((v) => v.id),
  );
  const sharedVarDetails = allSharedVars.filter((v) => linkedIds.has(v.id));

  return (
    <div className="space-y-6">
      <EnvManager
        appId={project.id}
        vars={vars}
        sharedVars={sharedVars}
        sharedVarDetails={sharedVarDetails}
      />
      {project.previewEnabled && (
        <PreviewOverrides appId={project.id} overrides={previewOverrides} />
      )}
    </div>
  );
}
