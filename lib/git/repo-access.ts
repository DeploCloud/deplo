import "server-only";

import { checkRepoVisible } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import { PROVIDERS } from "./providers/registry";
import type { GitRepo } from "../types/build";

const CHECK_TIMEOUT_MS = 10_000;

// ponytail: a regex over our own message text, and it fails OPEN when it misses.
export function isRefusal(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const status = /\((\d{3})\)/.exec(msg)?.[1];
  return status === "401" || status === "403" || status === "404";
}

export async function repoCloneRefusal(repo: GitRepo): Promise<string | null> {
  const full = repo.repo?.trim();
  if (!full) return null;

  if (repo.installationId) {
    try {
      await checkRepoVisible(
        repo.installationId,
        full,
        AbortSignal.timeout(CHECK_TIMEOUT_MS),
      );
      return null;
    } catch (e) {
      return isRefusal(e)
        ? `The GitHub App linked to this app cannot see ${full}. Add the repository to that installation on GitHub, or pick another App under the app's Deploy source settings.`
        : null;
    }
  }

  if (repo.connectionId) {
    try {
      const cred = await readGitCredential(repo.connectionId);
      const api = cred ? PROVIDERS[cred.provider]?.api : null;
      if (!cred || !api) return null;
      await api.listBranches(cred, full);
      return null;
    } catch (e) {
      return isRefusal(e)
        ? `The git connection linked to this app cannot see ${full}. Give its token access to the repository, or pick another connection under the app's Deploy source settings.`
        : null;
    }
  }

  if (repo.provider !== "github") return null;
  try {
    await checkRepoVisible(null, full, AbortSignal.timeout(CHECK_TIMEOUT_MS));
    return null;
  } catch (e) {
    const is404 = /\(404\)/.test(
      e instanceof Error ? e.message : String(e ?? ""),
    );
    return is404
      ? `${full} is not visible to an anonymous clone - it is private or gone, and this app has no GitHub App linked. Link one under the app's Deploy source settings.`
      : null;
  }
}
