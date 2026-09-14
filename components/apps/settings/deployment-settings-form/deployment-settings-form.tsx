"use client";

import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { BuildOutputCard } from "@/components/apps/settings/build-output-card";
import { AutoDeployCard } from "./auto-deploy-card";
import { DeploySourceCard } from "./deploy-source-card";
import {
  useDeploymentSettings,
  type DeploymentSettingsProps,
} from "./use-deployment-settings";

// DeploymentSettingsForm: how the app is built, where it runs, and what makes it deploy again.
export function DeploymentSettingsForm(props: DeploymentSettingsProps) {
  const settings = useDeploymentSettings(props);

  return (
    <>
      <div className="space-y-6">
        <DeploySourceCard {...props} settings={settings} />

        {/* Build & Output - single-image builds only. */}
        {settings.buildCardVisible && (
          <BuildOutputCard
            build={settings.build}
            onBuildChange={settings.setBuild}
            framework={settings.frameworkOverride ?? props.framework}
            detectedFramework={props.framework}
            onFrameworkChange={settings.setFrameworkOverride}
            dirty={settings.buildDirty}
            pending={settings.pending}
            onSave={settings.saveBuild}
          />
        )}

        {settings.autoDeployPossible && <AutoDeployCard settings={settings} />}
      </div>

      {/* Auto-deploy saves on change, so it doesn't count toward this. */}
      <UnsavedChangesGuard when={settings.overallDirty} />
    </>
  );
}
