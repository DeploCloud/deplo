"use client";

import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { BuildOutputCard } from "@/components/apps/settings/build-output-card";
import { ReleasesCard } from "./releases-card";
import { DeploySourceCard } from "./deploy-source-card";
import {
  useDeploymentSettings,
  type DeploymentSettingsProps,
} from "./use-deployment-settings";

export function DeploymentSettingsForm(props: DeploymentSettingsProps) {
  const settings = useDeploymentSettings(props);

  return (
    <>
      <div className="space-y-6">
        <DeploySourceCard {...props} settings={settings} />

        {settings.buildCardVisible && (
          <BuildOutputCard
            build={settings.build}
            onBuildChange={settings.setBuild}
            lastBuiltWith={props.lastBuiltWith}
            framework={settings.frameworkOverride ?? props.framework}
            detectedFramework={props.framework}
            onFrameworkChange={settings.setFrameworkOverride}
            dirty={settings.buildDirty}
            pending={settings.pending}
            onSave={settings.saveBuild}
          />
        )}

        {(settings.autoDeployPossible || props.rollbackKeep != null) && (
          <ReleasesCard
            settings={settings}
            appId={props.appId}
            rollbackKeep={props.rollbackKeep}
          />
        )}
      </div>

      <UnsavedChangesGuard when={settings.overallDirty} />
    </>
  );
}
