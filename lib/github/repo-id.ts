/**
 * How a stored {@link GitRepo} is turned into the `owner/name` GitHub uses to
 * address it. Pure (no `server-only`, no fetch) so every reader — the favicon
 * arm, framework recognition, anything later — resolves a repo the same way
 * instead of re-parsing the URL slightly differently.
 *
 * Whether a repo is GitHub-hosted at all is `isGithubRepo` in
 * {@link file://../apps/favicon-shared.ts}; this answers the next question.
 */
import type { GitRepo } from "../types";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/**
 * `owner/name` for a GitHub repo — the stored `repo.repo` when it already is
 * one, else parsed out of a github.com URL. Null when the repo isn't
 * GitHub-hosted or can't be resolved to a clean owner/name, which every caller
 * treats as "there is nothing to read here".
 */
export function githubFullName(
  repo: Pick<GitRepo, "repo" | "url"> | null | undefined,
): string | null {
  if (!repo) return null;
  if (repo.repo && OWNER_REPO.test(repo.repo)) return repo.repo.replace(/\.git$/, "");
  try {
    const url = new URL(repo.url ?? "");
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const path = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    return OWNER_REPO.test(path) ? path : null;
  } catch {
    return null;
  }
}
