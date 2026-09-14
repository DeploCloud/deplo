"use client";

import * as React from "react";
import { GitBranch } from "lucide-react";

import {
  FrameworkRow,
  FrameworkRowSkeleton,
} from "@/components/apps/framework-badge";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { RecognizedFramework } from "@/components/apps/use-repo-framework";
import { CommandField } from "@/components/apps/wizard/command-field";
import { WizardCard } from "@/components/apps/wizard/wizard-card";
import { Switch } from "@/components/ui/switch";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig } from "@/lib/types/build";

// ConfigureStep - the last card for a repository: what Deplo read, and the switch that keeps reading it.
export function ConfigureStep({
  meta,
  onBack,
  onNext,
  shouldDeploy,
  nextDisabled,
  pending,
  nameField,
  detectingFramework,
  framework,
  build,
  onBuildChange,
  prefilledBuild,
  prefilledStart,
  source,
  ghSelection,
  gitValue,
  autoDeploy,
  setAutoDeploy,
  noServer,
  hasServers,
  advanced,
}: {
  meta: React.ReactNode;
  onBack: () => void;
  onNext: () => void;
  shouldDeploy: boolean;
  nextDisabled: boolean;
  pending: boolean;
  nameField: React.ReactNode;
  detectingFramework: boolean;
  framework: RecognizedFramework | null;
  build: BuildConfig;
  onBuildChange: (next: BuildConfig) => void;
  prefilledBuild: string | null;
  prefilledStart: string | null;
  source: DeploySource | null;
  ghSelection: GithubSelection | null;
  gitValue: GitSourceValue;
  autoDeploy: boolean;
  setAutoDeploy: (on: boolean) => void;
  noServer: React.ReactNode;
  hasServers: boolean;
  advanced: React.ReactNode;
}) {
  return (
    <WizardCard
      title="Set up the app"
      description="Deplo read your repository. Change anything that looks wrong."
      meta={meta}
      onBack={onBack}
      onNext={onNext}
      nextLabel={shouldDeploy ? "Deploy" : "Create app"}
      deploy={shouldDeploy}
      nextDisabled={nextDisabled}
      pending={pending}
    >
      {nameField}

      {detectingFramework ? (
        <FrameworkRowSkeleton />
      ) : (
        framework && (
          <FrameworkRow
            id={framework.id}
            caption={`Detected in your repository · container port ${build.port}`}
          />
        )
      )}

      <CommandField
        id="build-command"
        label="Build command"
        info="Run to compile the app. Leave it empty and the builder works it out."
        value={build.buildCommand ?? ""}
        onChange={(v) => onBuildChange({ ...build, buildCommand: v })}
        detected={prefilledBuild}
        placeholder="Detected at build time"
      />
      <CommandField
        id="start-command"
        label="Deploy command"
        info="Run to start the container. Leave it empty and the builder works it out."
        value={build.startCommand ?? ""}
        onChange={(v) => onBuildChange({ ...build, startCommand: v })}
        detected={prefilledStart}
        placeholder="Detected at build time"
      />

      <div className="flex items-center justify-between rounded-lg border border-border p-3">
        <div className="flex items-center gap-2">
          <GitBranch className="size-5 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Automatic deployments</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Deploy on every push to{" "}
              {(source === "github" ? ghSelection?.branch : gitValue.branch) ||
                "main"}
              .
            </p>
          </div>
        </div>
        <Switch checked={autoDeploy} onCheckedChange={setAutoDeploy} />
      </div>

      {noServer}
      {hasServers && advanced}
    </WizardCard>
  );
}
