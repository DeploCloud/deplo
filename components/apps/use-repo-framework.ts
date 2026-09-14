"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import { supportsFrameworkDetection } from "@/lib/apps/framework-catalog";
import type { BuildMethod } from "@/lib/types/build";

export interface RecognizedFramework {
  id: string;
  name: string;
  defaultPort: number;
  staticOutput: string | null;
}

// RepoCommands - the repo's own build command, plus the framework's start.
export interface RepoCommands {
  buildCommand: string | null;
  startCommand: string | null;
}

const NO_COMMANDS: RepoCommands = { buildCommand: null, startCommand: null };

interface RepoRead {
  id: string | null;
  name: string | null;
  defaultPort: number | null;
  staticOutput: string | null;
  startCommand: string | null;
  buildCommand: string | null;
}

const SETTLE_MS = 400;

export interface RepoFrameworkInput {
  repo: string | null;
  url?: string | null;
  branch?: string | null;
  installationId?: string | null;
  buildMethod: BuildMethod;
  rootDirectory?: string | null;
}

export function useRepoFramework(input: RepoFrameworkInput): {
  framework: RecognizedFramework | null;
  commands: RepoCommands;
  detecting: boolean;
} {
  const { repo, url, branch, installationId, buildMethod, rootDirectory } =
    input;

  const query =
    repo && supportsFrameworkDetection(buildMethod)
      ? JSON.stringify({
          repo,
          url,
          branch,
          installationId,
          buildMethod,
          rootDirectory,
        })
      : null;

  const [answer, setAnswer] = React.useState<{
    query: string;
    read: RepoRead | null;
  } | null>(null);

  React.useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void gql<{ detectRepoFramework: RepoRead | null }>(
        `query($repo: String!, $url: String, $branch: String, $installationId: String, $buildMethod: String!, $rootDirectory: String) {
          detectRepoFramework(
            repo: $repo
            url: $url
            branch: $branch
            installationId: $installationId
            buildMethod: $buildMethod
            rootDirectory: $rootDirectory
          ) { id name defaultPort staticOutput startCommand buildCommand }
        }`,
        { repo, url, branch, installationId, buildMethod, rootDirectory },
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) {
            setAnswer({ query, read: data.detectRepoFramework ?? null });
          }
        })
        // Recording the empty answer on failure is what stops the skeleton.
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ query, read: null });
        });
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, repo, url, branch, installationId, buildMethod, rootDirectory]);

  const current = answer?.query === query ? answer : null;
  const read = current?.read ?? null;
  return {
    framework:
      read && read.id && read.name && read.defaultPort
        ? {
            id: read.id,
            name: read.name,
            defaultPort: read.defaultPort,
            staticOutput: read.staticOutput,
          }
        : null,
    commands: read
      ? { buildCommand: read.buildCommand, startCommand: read.startCommand }
      : NO_COMMANDS,
    detecting: Boolean(query) && current === null,
  };
}
