import type { GitRepo } from "../types/build";

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

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
