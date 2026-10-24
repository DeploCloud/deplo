"use client";

import { GitCommitHorizontal } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import { Switch } from "@/components/ui/switch";
import {
  GitDeployOptions,
  watchPathsToArray,
} from "@/components/apps/git-deploy-options";
import type { DeploymentSettings } from "./use-deployment-settings";

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
  const onTag = gitOptions.triggerType === "tag";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <GitCommitHorizontal className="size-4 text-muted-foreground" />
          Deploy on push
          <InfoTip
            content={
              onTag
                ? "Runs a deploy on every new tag."
                : `Runs a deploy on every push to ${autoDeployBranch}.`
            }
            docs="releases.autoDeploy"
          />
        </CardTitle>
        <Switch
          checked={autoDeploy}
          onCheckedChange={toggleAuto}
          disabled={pending}
          aria-label="Deploy on push"
        />
      </CardHeader>

      {repoConfigVisible && (
        <CardContent>
          <SettingsDrawer
            title="Trigger"
            summary={
              <>
                {onTag ? "On new tag" : "On push to branch"}
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
        </CardContent>
      )}
    </Card>
  );
}
