// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * How a stored {@link GitRepo} is turned into the `owner/name` GitHub uses to
 * address it.
 */
import type { GitRepo } from "../types";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * `owner/name` for a GitHub repo - the stored `repo.repo` when it already is one,
 * else parsed out of a github.com URL.
 */
export function githubFullName(
  repo: Pick<GitRepo, "repo" | "url"> | null | undefined,
): string | null {
  if (!repo) return null;
  if (repo.repo && OWNER_REPO.test(repo.repo))
    return repo.repo.replace(/\.git$/, "");
  try {
    const url = new URL(repo.url ?? "");
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return OWNER_REPO.test(path) ? path : null;
  } catch {
    return null;
  }
}
