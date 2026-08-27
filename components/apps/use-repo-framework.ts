"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import { supportsFrameworkDetection } from "@/lib/apps/framework-catalog";
import type { BuildMethod } from "@/lib/types";

/**
 * Live reading of a repository the user is still choosing - the new-app wizard's
 * "we already know what this is" moment, before any app row exists to carry the
 * answer. Two independent halves: the framework, and the commands the repo
 * declares for itself.
 */

export interface RecognizedFramework {
  id: string;
  name: string;
  defaultPort: number;
}

/** What the repository says its own build and start commands are. */
export interface RepoCommands {
  buildCommand: string | null;
  startCommand: string | null;
}

const NO_COMMANDS: RepoCommands = { buildCommand: null, startCommand: null };

/** The wire shape: every field can be null - a Go repo has commands and no
 *  framework, an empty one has neither. */
interface RepoRead {
  id: string | null;
  name: string | null;
  defaultPort: number | null;
  buildCommand: string | null;
  startCommand: string | null;
}

/** How long the inputs must hold still before a request goes out. Long enough
 * that typing a repo URL character by character costs one read, not twenty. */
const SETTLE_MS = 400;

export interface RepoFrameworkInput {
  /** `owner/name`, or null when there is no GitHub repository to read yet. */
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

  /**
   * Everything the answer depends on, as one value.
   */
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
          ) { id name defaultPort buildCommand startCommand }
        }`,
        { repo, url, branch, installationId, buildMethod, rootDirectory },
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) {
            setAnswer({ query, read: data.detectRepoFramework ?? null });
          }
        })
        // Nothing is broken when a repository can't be read - the badge simply
        // never appears. Recording the empty answer stops the skeleton.
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
        ? { id: read.id, name: read.name, defaultPort: read.defaultPort }
        : null,
    commands: read
      ? { buildCommand: read.buildCommand, startCommand: read.startCommand }
      : NO_COMMANDS,
    detecting: Boolean(query) && current === null,
  };
}
