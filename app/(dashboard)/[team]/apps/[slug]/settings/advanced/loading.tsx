"use client";

import { Hammer, SlidersHorizontal, Sparkles } from "lucide-react";
import {
  RowsCard,
  SettingsSection,
} from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { ConsoleSettingsForm } from "@/components/apps/settings/console-settings-form";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { HealthCheckForm } from "@/components/apps/settings/health-check-form";
import { RestartLoopForm } from "@/components/apps/settings/restart-loop-form";
import { ScreenshotsForm } from "@/components/apps/settings/screenshots-form";
import { PublishedPortsForm } from "@/components/apps/settings/published-ports-form";
import { BuildCachePanel } from "@/components/apps/settings/build-cache-panel";
import { BuildServerPanel } from "@/components/apps/settings/build-server-panel";
import { ComposeArgsPanel } from "@/components/apps/settings/compose-args-panel";
import { RebuildContainerRow } from "@/components/apps/settings/rebuild-container-row";
import { TraefikLabelsForm } from "@/components/apps/settings/traefik-labels-form";
import { DangerSettings } from "@/components/apps/settings/danger-settings";
import { DeployHookPanel } from "@/components/apps/settings/deploy-hook-panel";
import { useAppNav } from "@/components/apps/app-nav-store";

// The frame already knows the app's flags; the rest is drawn for an app built from a repository.
export default function Loading() {
  const nav = useAppNav();
  return (
    <SettingsLoading className="space-y-4">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        docs="build.advanced"
        info="Turn on the advanced features, rebuild the container from scratch, hand the app to another team, or permanently delete it."
      />
      <RowsCard
        icon={Sparkles}
        title="Features"
        info="Powerful extras, off the everyday path until you need them."
        docs="build.advanced"
      >
        <CapabilityFieldset cap="configure_apps">
          <ConsoleSettingsForm
            appId=""
            slug=""
            enabled={nav?.consoleEnabled ?? false}
            canConsole={false}
          />
        </CapabilityFieldset>
        <CapabilityFieldset cap="manage_crons">
          <CronSettingsForm
            targetKind="app"
            targetId=""
            enabled={nav?.cronsEnabled ?? false}
            jobCount={0}
          />
        </CapabilityFieldset>
        <CapabilityFieldset cap="configure_apps">
          <HealthCheckForm appId="" healthCheck={null} />
        </CapabilityFieldset>
        <CapabilityFieldset cap="configure_apps">
          <RestartLoopForm targetKind="app" targetId="" enabled />
        </CapabilityFieldset>
        <CapabilityFieldset cap="configure_apps">
          <ScreenshotsForm appId="" enabled />
        </CapabilityFieldset>
        <CapabilityFieldset cap="configure_apps">
          <PublishedPortsForm appId="" ports={[]} canExposePorts={false} />
        </CapabilityFieldset>
      </RowsCard>
      <RowsCard
        icon={Hammer}
        title="Build & triggers"
        info="How builds reuse their cache, where they run, and what can start one from outside Deplo."
        docs="build.cache"
      >
        <CapabilityFieldset cap="configure_apps">
          <BuildCachePanel appId="" buildCache clearPending={false} />
          <BuildServerPanel
            appId=""
            serverId=""
            serverName="its own server"
            serverArch=""
            buildServerId={null}
            buildFallback={false}
            choices={[]}
          />
          <ComposeArgsPanel appId="" slug="" value={null} usesEnvFile={false} />
          {nav && !nav.isGithubApp && (
            <DeployHookPanel appId="" enabled maskedUrl="" />
          )}
        </CapabilityFieldset>
        <RebuildContainerRow appId="" slug="" source="github" />
      </RowsCard>
      <TraefikLabelsForm appId="" labels={[]} />
      <DangerSettings appId="" name="" />
    </SettingsLoading>
  );
}
