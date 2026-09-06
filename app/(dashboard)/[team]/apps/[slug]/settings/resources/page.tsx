import { notFound } from "next/navigation";
import { Cpu } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { getAppMetricsHistory } from "@/lib/data/container-metrics";
import { hasAppCapability } from "@/lib/data/node-access";
import { listServers } from "@/lib/data/servers";
import { canMountHostVolumes } from "@/lib/membership";
import { serverLabel, usesComposeStack } from "@/lib/utils";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { ResourceLimitsForm } from "@/components/apps/settings/resource-limits-form";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";

export const metadata = { title: "Resources" };

/** Per-app caps, baked into the rendered compose on the next deploy. */
export default async function AppResourcesSettingsPage(
  props: PageProps<"/[team]/apps/[slug]/settings/resources">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const [servers, canViewMetrics, canRedeploy, canProtectFromOom] =
    await Promise.all([
      listServers(),
      hasAppCapability(project.id, "view_metrics"),
      hasAppCapability(project.id, "deploy_apps"),
      canMountHostVolumes(),
    ]);
  const server = servers.find((s) => s.id === project.serverId);
  const usage = canViewMetrics ? await getAppMetricsHistory(project.id) : null;

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={Cpu}
        title="Resources"
        docs="resources.overview"
        info="Cap how much RAM, CPU, disk and processes this app may use. Applied on the next deploy."
      />
      <CapabilityFieldset cap="configure_apps">
        <ResourceLimitsForm
          kind="app"
          id={project.id}
          slug={project.slug}
          resources={project.resources}
          isComposeStack={usesComposeStack(project)}
          host={
            server
              ? {
                  name: serverLabel(server),
                  memoryMb: server.memoryMb,
                  cpuCores: server.cpuCores,
                }
              : null
          }
          usage={usage}
          canRedeploy={canRedeploy}
          canProtectFromOom={canProtectFromOom}
        />
      </CapabilityFieldset>
    </section>
  );
}
