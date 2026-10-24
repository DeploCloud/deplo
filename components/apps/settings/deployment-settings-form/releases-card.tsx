"use client";

import * as React from "react";
import { toast } from "sonner";
import { History, Save } from "lucide-react";
import { Card, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import { SettingsDrawer } from "@/components/shared/settings-drawer";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import {
  GitDeployOptions,
  watchPathsToArray,
} from "@/components/apps/git-deploy-options";
import { useRouter } from "@/lib/nav";
import { gqlAction } from "@/lib/graphql-client";
import { MAX_ROLLBACK_KEEP } from "@/lib/types/app";
import type { DocsTopic } from "@/lib/docs";
import type { DeploymentSettings } from "./use-deployment-settings";

export function ReleasesCard({
  settings,
  appId,
  rollbackKeep,
}: {
  settings: DeploymentSettings;
  appId: string;
  // null when the app has no build of its own to keep.
  rollbackKeep: number | null;
}) {
  const {
    autoDeploy,
    toggleAuto,
    autoDeployPossible,
    autoDeployBranch,
    repoConfigVisible,
    gitOptions,
    setGitOptions,
    triggerDirty,
    saveSource,
  } = settings;
  const router = useRouter();
  const [keepPending, startKeep] = React.useTransition();
  const pending = settings.pending || keepPending;

  const [keep, setKeep] = React.useState(String(rollbackKeep ?? 0));
  const [savedKeep, setSavedKeep] = React.useState(String(rollbackKeep ?? 0));
  const keepDirty = rollbackKeep != null && keep.trim() !== savedKeep;
  const parsedKeep = Math.min(
    MAX_ROLLBACK_KEEP,
    Math.max(0, Math.trunc(Number(keep) || 0)),
  );

  const showTrigger = autoDeployPossible && repoConfigVisible;
  const dirty = keepDirty || triggerDirty;
  const onTag = gitOptions.triggerType === "tag";

  function saveKeep() {
    startKeep(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $count: Int!) {
           setAppRollbackKeep(id: $id, count: $count) { id }
         }`,
        { id: appId, count: parsedKeep },
      );
      if (res.ok) {
        setKeep(String(parsedKeep));
        setSavedKeep(String(parsedKeep));
        router.refresh();
        toast.success(
          parsedKeep === 0
            ? "No builds kept on the server"
            : `Keeping ${parsedKeep} ${parsedKeep === 1 ? "rollback" : "rollbacks"}`,
        );
      } else toast.error(res.error);
    });
  }

  function save() {
    if (keepDirty) saveKeep();
    if (triggerDirty) saveSource();
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <History className="size-4 text-muted-foreground" />
            Releases
            <InfoTip
              content="How new code goes live, and how fast you can go back."
              docs="releases.autoDeploy"
            />
          </CardTitle>
        </CardHeader>

        <div className="divide-y divide-border border-t border-border">
          {autoDeployPossible && (
            <Row
              htmlFor="deploy-on-push"
              label="Deploy on push"
              description={
                onTag
                  ? "Every new tag goes live."
                  : `Every push to ${autoDeployBranch} goes live.`
              }
              info="Turn it off to deploy only when you press Deploy."
              docs="releases.autoDeploy"
            >
              <Switch
                id="deploy-on-push"
                checked={autoDeploy}
                onCheckedChange={toggleAuto}
                disabled={pending}
              />
            </Row>
          )}

          {showTrigger && (
            <SettingsDrawer
              flush
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
          )}

          {rollbackKeep != null && (
            <Row
              htmlFor="rollback-keep"
              label="Rollbacks kept"
              description="Go back to one of these instantly, without rebuilding."
              info="Older ones from a repository are rebuilt from their commit, which takes a few minutes."
              docs="releases.rollbackRetention"
            >
              <div className="relative w-36">
                <Input
                  id="rollback-keep"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={MAX_ROLLBACK_KEEP}
                  value={keep}
                  disabled={pending}
                  onChange={(e) => setKeep(e.target.value)}
                  className="[appearance:textfield] pr-20 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                />
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
                  {parsedKeep === 1 ? "rollback" : "rollbacks"}
                </span>
              </div>
            </Row>
          )}
        </div>

        {(rollbackKeep != null || showTrigger) && (
          <CardFooter className="justify-between border-t border-border pt-4">
            <DirtyHint dirty={dirty} />
            <Button onClick={save} disabled={pending || !dirty}>
              <Save className="size-4" />
              Save
            </Button>
          </CardFooter>
        )}
      </Card>

      <UnsavedChangesGuard when={keepDirty} />
    </>
  );
}

function Row({
  htmlFor,
  label,
  description,
  info,
  docs,
  children,
}: {
  htmlFor: string;
  label: string;
  description: string;
  info: string;
  docs: DocsTopic;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0">
        <FieldLabel htmlFor={htmlFor} info={info} docs={docs}>
          {label}
        </FieldLabel>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
