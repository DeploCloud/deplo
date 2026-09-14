"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { SettingRow } from "@/components/shared/setting-row";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import { Switch } from "@/components/ui/switch";
import {
  GitDeployOptions,
  watchPathsToArray,
} from "@/components/apps/git-deploy-options";
import type { DeploymentSettings } from "./use-deployment-settings";

// AutoDeployCard: the deploy-on-push switch and the trigger that shapes it.
export function AutoDeployCard({ settings }: { settings: DeploymentSettings }) {
  const {
    autoDeploy,
    toggleAuto,
    pending,
    autoDeployBranch,
    repoConfigVisible,
    gitOptions,
    setGitOptions,
  } = settings;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Deploy on push
          <InfoTip
            content={`Runs a deploy on every push to ${autoDeployBranch}.`}
            docs="releases.autoDeploy"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SettingRow
          label="Deploy on push"
          info={`Runs a deploy on every push to ${autoDeployBranch}.`}
          docs="releases.autoDeploy"
        >
          <Switch
            checked={autoDeploy}
            onCheckedChange={toggleAuto}
            disabled={pending}
            aria-label="Deploy on push"
          />
        </SettingRow>

        {repoConfigVisible && (
          <SettingsDrawer
            title="Trigger"
            summary={
              <>
                {gitOptions.triggerType === "tag"
                  ? "On new tag"
                  : "On push to branch"}
                {watchPathsToArray(gitOptions.watchPaths).length > 0 &&
                  " · path-filtered"}
                {gitOptions.submodules && " · submodules"}
              </>
            }
          >
            <GitDeployOptions
              value={gitOptions}
              onChange={setGitOptions}
              disabled={pending}
            />
          </SettingsDrawer>
        )}
      </CardContent>
    </Card>
  );
}
