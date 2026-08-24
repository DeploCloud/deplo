"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import { supportsFrameworkDetection } from "@/lib/apps/framework-catalog";
import type { BuildMethod } from "@/lib/types";

/**
 * Live framework recognition for a repository the user is still choosing — the
 * new-app wizard's "we already know what this is" moment, before any app row
 * exists to carry the answer.
 *
 * The read costs a GitHub round-trip, so it is spent carefully: nothing is
 * requested unless the build method is one that recognition applies to (the same
 * {@link supportsFrameworkDetection} gate the server enforces), the repository is
 * settled for a moment, and the previous request is abandoned the instant the
 * inputs change. A failure is silence — no toast, no error state. Nothing is
 * broken when Deplo can't name a framework; there is simply nothing to show.
 */

export interface RecognizedFramework {
  id: string;
  name: string;
  defaultPort: number;
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
  detecting: boolean;
} {
  const { repo, url, branch, installationId, buildMethod, rootDirectory } =
    input;

  /**
   * Everything the answer depends on, as one value. Results are STAMPED with it,
   * which is what makes both derived states honest with no extra bookkeeping: an
   * answer whose stamp no longer matches is an answer to a question about a
   * different repository, so it reads as "still looking" rather than lingering
   * under the new one. It also means no state is written just to record that a
   * request started.
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
    framework: RecognizedFramework | null;
  } | null>(null);

  React.useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void gql<{ detectRepoFramework: RecognizedFramework | null }>(
        `query($repo: String!, $url: String, $branch: String, $installationId: String, $buildMethod: String!, $rootDirectory: String) {
          detectRepoFramework(
            repo: $repo
            url: $url
            branch: $branch
            installationId: $installationId
            buildMethod: $buildMethod
            rootDirectory: $rootDirectory
          ) { id name defaultPort }
        }`,
        { repo, url, branch, installationId, buildMethod, rootDirectory },
        controller.signal,
      )
        .then((data) => {
          if (!controller.signal.aborted) {
            setAnswer({ query, framework: data.detectRepoFramework ?? null });
          }
        })
        // Nothing is broken when a repository can't be read — the badge simply
        // never appears. Recording the empty answer stops the skeleton.
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ query, framework: null });
        });
    }, SETTLE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, repo, url, branch, installationId, buildMethod, rootDirectory]);

  const current = answer?.query === query ? answer : null;
  return {
    framework: current?.framework ?? null,
    detecting: Boolean(query) && current === null,
  };
}
