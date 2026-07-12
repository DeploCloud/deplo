import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { hasCapability } from "@/lib/membership";
import { listEnv } from "@/lib/data/env";
import { listSharedVarsForApp } from "@/lib/data/shared-vars";
import { EnvManager } from "@/components/env/env-manager";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Environment Variables" };

export default async function AppEnvPage(
  props: PageProps<"/apps/[slug]/environment">
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  // Viewing env values requires manage_env. Without it the tab is hidden, but
  // guard the page too in case of a direct link / stale navigation.
  if (!(await hasCapability("manage_env"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to environment variables"
        description="You don't have permission to view this app's environment variables. Ask a team admin for the “Manage env vars” permission."
      />
    );
  }

  const [vars, sharedVars] = await Promise.all([
    listEnv(project.id),
    listSharedVarsForApp(project.id),
  ]);

  return <EnvManager appId={project.id} vars={vars} sharedVars={sharedVars} />;
}
