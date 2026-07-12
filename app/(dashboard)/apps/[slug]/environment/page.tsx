import { notFound } from "next/navigation";
import { Lock } from "lucide-react";
import { getServiceBySlug } from "@/lib/data/services";
import { hasCapability } from "@/lib/membership";
import { listEnv } from "@/lib/data/env";
import { listSharedEnvGroupsForService } from "@/lib/data/shared-env";
import { EnvManager } from "@/components/env/env-manager";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Environment Variables" };

export default async function ServiceEnvPage(
  props: PageProps<"/services/[slug]/environment">
) {
  const { slug } = await props.params;
  const project = await getServiceBySlug(slug);
  if (!project) notFound();

  // Viewing env values requires manage_env. Without it the tab is hidden, but
  // guard the page too in case of a direct link / stale navigation.
  if (!(await hasCapability("manage_env"))) {
    return (
      <EmptyState
        icon={Lock}
        title="No access to environment variables"
        description="You don't have permission to view this service's environment variables. Ask a team admin for the “Manage env vars” permission."
      />
    );
  }

  const [vars, sharedGroups] = await Promise.all([
    listEnv(project.id),
    listSharedEnvGroupsForService(project.id),
  ]);

  return (
    <EnvManager
      serviceId={project.id}
      vars={vars}
      sharedGroups={sharedGroups}
    />
  );
}
