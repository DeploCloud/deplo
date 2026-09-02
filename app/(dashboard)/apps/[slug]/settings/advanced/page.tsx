import { notFound } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { getAppBySlug } from "@/lib/data/apps";
import { deployHookUrlMasked } from "@/lib/data/deploy-hook";
import { listBuildServerChoices } from "@/lib/data/servers";
import { hasAppCapability } from "@/lib/data/node-access";
import { canExposePorts } from "@/lib/membership";
import { listAppCronJobs } from "@/lib/data/crons";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { DangerSettings } from "@/components/apps/settings/danger-settings";
import { RebuildContainerCard } from "@/components/apps/settings/rebuild-container-card";
import { ConsoleSettingsForm } from "@/components/apps/settings/console-settings-form";
import { HealthCheckForm } from "@/components/apps/settings/health-check-form";
import { PublishedPortsForm } from "@/components/apps/settings/published-ports-form";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { BuildCachePanel } from "@/components/apps/settings/build-cache-panel";
import { BuildServerPanel } from "@/components/apps/settings/build-server-panel";
import { ComposeArgsPanel } from "@/components/apps/settings/compose-args-panel";
import { DeployHookPanel } from "@/components/apps/settings/deploy-hook-panel";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { providerFor } from "@/lib/git/providers";
import { appBuildsItsOwnImage, usesComposeStack } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata = { title: "Advanced" };

/**
 * Advanced app settings: the powerful, less-everyday controls in one place - the
 * Advanced features card (the container Console and Cron jobs), the build and
 * trigger controls that nobody touches on a first deploy, a from-scratch
 * container Rebuild, and the Danger Zone (transfer to another team, delete).
 */
export default async function AppAdvancedSettingsPage(
  props: PageProps<"/apps/[slug]/settings/advanced">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();
  // The console page refuses without this, so the row says so up front instead of
  // handing out a link that 404s.
  const [canConsole, canCron, mayExposePorts, buildServerChoices] =
    await Promise.all([
      hasAppCapability(project.id, "open_app_console"),
      hasAppCapability(project.id, "manage_crons"),
      canExposePorts(),
      listBuildServerChoices(),
    ]);
  const cron = canCron ? await listAppCronJobs(project.id) : null;

  // Same predicates the Deployments page used before these panels moved here.
  const isComposeStack = usesComposeStack(project);
  const buildsOwnImage = appBuildsItsOwnImage(project);
  // A git provider that already triggers deploys makes a second trigger one more
  // credential to leak for a job already done, so the hook is not offered.
  const providerTriggers =
    project.source === "github" ||
    (Boolean(project.repo?.connectionId) &&
      providerFor(project.repo?.provider ?? "git").api != null);
  const hookUrl = providerTriggers
    ? null
    : await deployHookUrlMasked(project.id);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        docs="build.advanced"
        info="Turn on the advanced features, rebuild the container from scratch, hand the app to another team, or permanently delete it."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Advanced features</CardTitle>
          <CardDescription>
            Powerful extras, off the everyday path until you need them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CapabilityFieldset cap="configure_apps">
            <ConsoleSettingsForm
              appId={project.id}
              slug={slug}
              enabled={project.consoleEnabled}
              canConsole={canConsole}
            />
          </CapabilityFieldset>

          <CapabilityFieldset cap="manage_crons">
            <CronSettingsForm
              targetKind="app"
              targetId={project.id}
              enabled={cron?.enabled ?? project.cronEnabled}
              jobCount={cron?.jobs.length ?? 0}
            />
          </CapabilityFieldset>

          {project.source !== "compose" && (
            <CapabilityFieldset cap="configure_apps">
              <HealthCheckForm
                appId={project.id}
                healthCheck={project.healthCheck}
              />
            </CapabilityFieldset>
          )}

          {/* A compose stack publishes its own ports in its own YAML. */}
          {project.source !== "compose" && (
            <CapabilityFieldset cap="configure_apps">
              <PublishedPortsForm
                appId={project.id}
                ports={project.ports ?? []}
                canExposePorts={mayExposePorts}
              />
            </CapabilityFieldset>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Build &amp; triggers</CardTitle>
          <CardDescription>
            How builds reuse their cache, where they run, and what can start one
            from outside Deplo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CapabilityFieldset cap="configure_apps">
            {buildsOwnImage && (
              <BuildCachePanel
                appId={project.id}
                buildCache={project.build.buildCache}
                clearPending={project.build.buildCacheClearPending}
              />
            )}
            {buildsOwnImage && (
              <BuildServerPanel
                appId={project.id}
                serverId={project.serverId}
                serverName={
                  buildServerChoices.find((c) => c.id === project.serverId)
                    ?.name ?? "its own server"
                }
                serverArch={
                  buildServerChoices.find((c) => c.id === project.serverId)
                    ?.hostArch ?? ""
                }
                buildServerId={project.buildServerId ?? null}
                buildFallbackLocal={project.buildFallbackLocal}
                choices={buildServerChoices}
              />
            )}
            <ComposeArgsPanel
              appId={project.id}
              slug={slug}
              value={project.composeUpArgs}
              usesEnvFile={isComposeStack}
            />
            {hookUrl && (
              <DeployHookPanel
                appId={project.id}
                enabled={project.deployHookEnabled}
                maskedUrl={hookUrl}
              />
            )}
          </CapabilityFieldset>
        </CardContent>
      </Card>

      <RebuildContainerCard appId={project.id} slug={slug} />

      <DangerSettings appId={project.id} name={project.name} />
    </section>
  );
}
