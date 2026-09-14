import "server-only";

import { checkRepoVisible } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import { PROVIDERS } from "./providers/registry";
import type { GitRepo } from "../types/build";

// How long a pre-flight may hold up a deploy before it gives up and proceeds.
const CHECK_TIMEOUT_MS = 10_000;

// An EXPLICIT refusal: every adapter spells the HTTP status into the message, and a timeout, a 5xx or a rate limit is NOT one.
// ponytail: a regex over our own message text, and it fails OPEN when it misses.
// Give the adapters a real status field if a fifth provider words errors otherwise.
export function isRefusal(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const status = /\((\d{3})\)/.exec(msg)?.[1];
  return status === "401" || status === "403" || status === "404";
}

// Why this repository will not clone, as a sentence for the deploy log - or null to go ahead.
export async function repoCloneRefusal(repo: GitRepo): Promise<string | null> {
  const full = repo.repo?.trim();
  // A bare clone URL names no `owner/name` to ask an API about. Nothing to check.
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
      // No API to ask (a plain git server), or a connection since deleted: let the clone be the judge, as it always was.
      const api = cred ? PROVIDERS[cred.provider]?.api : null;
      if (!cred || !api) return null;
      // The existing per-repo call: it 404s on a repository the token cannot see.
      await api.listBranches(cred, full);
      return null;
    } catch (e) {
      return isRefusal(e)
        ? `The git connection linked to this app cannot see ${full}. Give its token access to the repository, or pick another connection under the app's Deploy source settings.`
        : null;
    }
  }

  // No credential at all: the clone is anonymous, and only GitHub can be asked that cheaply.
  if (repo.provider !== "github") return null;
  try {
    await checkRepoVisible(null, full, AbortSignal.timeout(CHECK_TIMEOUT_MS));
    return null;
  } catch (e) {
    // ONLY a 404 counts: unauthenticated GitHub answers 403 for rate limiting, which this instance is known to exhaust.
    const is404 = /\(404\)/.test(
      e instanceof Error ? e.message : String(e ?? ""),
    );
    return is404
      ? `${full} is not visible to an anonymous clone - it is private or gone, and this app has no GitHub App linked. Link one under the app's Deploy source settings.`
      : null;
  }
}
