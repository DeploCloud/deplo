"use client";

import { useRepoAnalysis } from "./use-repo-analysis";

import * as React from "react";

import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import { useRepoFramework } from "@/components/apps/use-repo-framework";
import { buildConfigFor } from "@/lib/frameworks";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig } from "@/lib/types/build";

import { parseRepo } from "./source-hints";

export function useBuildConfig({
  source,
  buildsImage,
  ghSelection,
  gitValue,
  serverId,
  buildServerId,
  placement,
}: {
  source: DeploySource | null;
  buildsImage: boolean;
  ghSelection: GithubSelection | null;
  gitValue: GitSourceValue;
  serverId: string;
  buildServerId: string | null;
  placement?: {
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  } | null;
}) {
  const [draftBuild, setDraftBuild] = React.useState(() => buildConfigFor());
  const [portTouched, setPortTouched] = React.useState(false);
  const [imagePort, setImagePort] = React.useState<number | null>(null);
  const [outputTouched, setOutputTouched] = React.useState(false);
  const [commandsTouched, setCommandsTouched] = React.useState(false);

  const gitRepoParsed = source === "git" ? parseRepo(gitValue.url) : null;
  const detectRepo =
    source === "github" && ghSelection
      ? {
          repo: ghSelection.fullName,
          url: `https://github.com/${ghSelection.fullName}`,
          branch: ghSelection.branch || "main",
          installationId: ghSelection.installationId,
        }
      : gitRepoParsed && gitRepoParsed.provider === "github"
        ? {
            repo: gitRepoParsed.repo,
            url: gitValue.url.trim(),
            branch: gitValue.branch || "main",
            installationId: null,
          }
        : null;

  const {
    framework,
    commands,
    detecting: detectingFramework,
  } = useRepoFramework({
    repo: null,
    url: detectRepo?.url,
    branch: detectRepo?.branch,
    installationId: detectRepo?.installationId,
    buildMethod: draftBuild.buildMethod,
    rootDirectory: draftBuild.rootDirectory,
  });

  const usesDeplopack =
    source === "github" ||
    (source === "git" && gitRepoParsed?.provider === "github");
  const deplopack = useRepoAnalysis(
    usesDeplopack
      ? {
          repo: detectRepo?.repo ?? "",
          branch: detectRepo?.branch,
          installationId: detectRepo?.installationId,
          connectionId: source === "git" ? gitValue.connectionId : null,
          serverId,
          buildServerId,
          rootDirectory: draftBuild.rootDirectory,
          ...placement,
        }
      : null,
  );

  const build = React.useMemo(() => {
    let next = usesDeplopack
      ? { ...draftBuild, buildMethod: "deplopack" as const }
      : draftBuild;
    if (framework && !portTouched && next.port !== framework.defaultPort) {
      next = { ...next, port: framework.defaultPort };
    }
    if (imagePort && !portTouched && next.port !== imagePort) {
      next = { ...next, port: imagePort };
    }
    if (framework?.staticOutput && !outputTouched && !next.outputDirectory) {
      next = { ...next, outputDirectory: framework.staticOutput };
    }
    if (!commandsTouched && (commands.buildCommand || commands.startCommand)) {
      next = {
        ...next,
        buildCommand: commands.buildCommand ?? next.buildCommand,
        startCommand: commands.startCommand ?? next.startCommand,
      };
    }
    return next;
  }, [
    draftBuild,
    usesDeplopack,
    framework,
    imagePort,
    portTouched,
    outputTouched,
    commands,
    commandsTouched,
  ]);

  const prefilledBuild = !commandsTouched ? commands.buildCommand : null;
  const prefilledStart = !commandsTouched ? commands.startCommand : null;

  function onBuildChange(next: BuildConfig) {
    if (next.port !== build.port) setPortTouched(true);
    if (next.outputDirectory !== build.outputDirectory) setOutputTouched(true);
    if (
      next.buildCommand !== build.buildCommand ||
      next.startCommand !== build.startCommand
    ) {
      setCommandsTouched(true);
    }
    setDraftBuild(
      usesDeplopack ? { ...next, buildMethod: draftBuild.buildMethod } : next,
    );
  }

  return {
    build,
    deplopack,
    onBuildChange,
    framework,
    detectingFramework,
    prefilledBuild,
    prefilledStart,
    setImagePort,
  };
}
