"use client";

import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import { SettingRow } from "@/components/shared/setting-row";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import type { DeploymentSettings } from "./use-deployment-settings";

export function AdditionalOptionsDrawer({
  settings,
}: {
  settings: DeploymentSettings;
}) {
  const { closedSummary, build, setBuild, pending } = settings;

  return (
    <SettingsDrawer title="Additional options" summary={closedSummary}>
      <SettingRow
        label="Root directory"
        htmlFor="root-directory"
        info='Sub-folder to build from, e.g. "apps/web" in a monorepo. Leave as ./ to build from the repository root'
        docs="build.fields"
      >
        <RootDirectoryFields
          build={build}
          onBuildChange={setBuild}
          disabled={pending}
          bare
        />
      </SettingRow>
    </SettingsDrawer>
  );
}
