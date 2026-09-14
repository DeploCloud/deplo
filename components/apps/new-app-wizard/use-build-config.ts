"use client";

import * as React from "react";

import type { GithubSelection } from "@/components/apps/github-repo-picker";
import type { GitSourceValue } from "@/components/apps/git-source-picker";
import { useRepoFramework } from "@/components/apps/use-repo-framework";
import { buildConfigFor } from "@/lib/frameworks";
import type { DeploySource } from "@/lib/types/app";
import type { BuildConfig } from "@/lib/types/build";

import { parseRepo } from "./source-hints";

// useBuildConfig - what the repository tells us about itself, layered onto what the user typed.
export function useBuildConfig({
  source,
  buildsImage,
  ghSelection,
  gitValue,
}: {
  source: DeploySource | null;
  buildsImage: boolean;
  ghSelection: GithubSelection | null;
  gitValue: GitSourceValue;
}) {
  // What the user has actually chosen. `build` below is this with what the
  // repository told us layered on.
  const [draftBuild, setDraftBuild] = React.useState(() => buildConfigFor());
  const [portTouched, setPortTouched] = React.useState(false);
  /** What the picked image declares in its own EXPOSE, or null. */
  const [imagePort, setImagePort] = React.useState<number | null>(null);
  const [outputTouched, setOutputTouched] = React.useState(false);
  const [commandsTouched, setCommandsTouched] = React.useState(false);

  const gitRepoParsed = source === "git" ? parseRepo(gitValue.url) : null;
  const detectRepo =
    source === "github" && ghSelection
      ? {
          repo: ghSelection.fullName,
          url: `https://github.com/${ghSelection.fullName}`,
          branch: ghSelection.branch || "",
          installationId: ghSelection.installationId,
        }
      : gitRepoParsed && gitRepoParsed.provider === "github"
        ? {
            repo: gitRepoParsed.repo,
            url: gitValue.url.trim(),
            branch: gitValue.branch,
            installationId: null,
          }
        : null;

  const {
    framework,
    commands,
    detecting: detectingFramework,
  } = useRepoFramework({
    repo: buildsImage ? (detectRepo?.repo ?? null) : null,
    url: detectRepo?.url,
    branch: detectRepo?.branch,
    installationId: detectRepo?.installationId,
    buildMethod: draftBuild.buildMethod,
    rootDirectory: draftBuild.rootDirectory,
  });

  // The port follows the recognised framework's own server instead of a
  // hardcoded 3000, and the build command follows the repo's package.json - until
  // the user edits either, after which what they typed wins.
  const build = React.useMemo(() => {
    let next = draftBuild;
    if (framework && !portTouched && next.port !== framework.defaultPort) {
      next = { ...next, port: framework.defaultPort };
    }
    // A prebuilt image has no repository to read: what it declares in its own
    // EXPOSE is the only honest default, and 3000 is a guess that 502s.
    if (imagePort && !portTouched && next.port !== imagePort) {
      next = { ...next, port: imagePort };
    }
    // A framework that builds a directory and runs no server is SERVED, not started.
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
    setDraftBuild(next);
  }

  return {
    build,
    onBuildChange,
    framework,
    detectingFramework,
    prefilledBuild,
    prefilledStart,
    setImagePort,
  };
}
