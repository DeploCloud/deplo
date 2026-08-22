import "server-only";

import { checkRepoVisible } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import { PROVIDERS } from "./providers";
import type { GitRepo } from "../types";

/** How long a pre-flight may hold up a deploy before it gives up and proceeds. */
const CHECK_TIMEOUT_MS = 10_000;

/**
 * Whether an error is an EXPLICIT refusal by the provider.
 *
 * Both families spell the HTTP status into the message at the throw site
 * (`GitHub repo check failed (404)`, `GitLab request failed (403): …`), so one
 * regex reads all four providers. A timeout, a 5xx, a rate limit, a DNS failure
 * or a message with no status at all is NOT a refusal: the deploy proceeds
 * exactly as it does today.
 *
 * The direction matters. This check exists to explain a failure that was going
 * to happen anyway - it must never invent one. A bad minute at GitHub failing a
 * deploy that would have worked is strictly worse than the opaque error this
 * replaces.
 *
 * ponytail: a regex over our own message text, because the alternative is
 * threading a `status` field through four adapters and their call sites. It
 * fails OPEN when it misses, which is the safe direction - give the adapters a
 * real status field if a fifth provider words its errors differently.
 */
export function isRefusal(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const status = /\((\d{3})\)/.exec(msg)?.[1];
  return status === "401" || status === "403" || status === "404";
}

/**
 * Why this repository will not clone, as a sentence for the deploy log - or
 * null to go ahead.
 *
 * The question {@link resolveCloneUrl} never asks. That function picks a
 * credential and hands back a URL; whether the credential can actually reach the
 * repository is discovered by git, on the agent, which reports back only
 * `git clone failed: exit status 128` with no stderr. The control plane is
 * therefore the ONLY place a usable message can come from, which is why this
 * runs here and not as a nicer rendering of the agent's error.
 *
 * Mirrors resolveCloneUrl's three branches in the same order, so the two cannot
 * disagree about which credential is in play:
 *
 *  - an installation: ask GitHub whether that App sees the repo;
 *  - a connection: ask the provider (a repo the token cannot see 404s);
 *  - neither: the clone will be ANONYMOUS, so ask as an anonymous caller. A
 *    public repo answers 200 and deploys as it always has; only a 404 is a
 *    problem, and only for a provider we can ask (a plain git server has no API).
 *
 * Needs no `requireActiveTeamId`: it is called with a `GitRepo` already loaded
 * from the app row that a team-scoped, capability-gated mutation wrote - the
 * same contract {@link readGitCredential} documents - and it returns a message
 * or null, never repository contents.
 */
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
      // No API to ask (a plain git server), or a connection that has since been
      // deleted: let the clone be the judge, as it always was.
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

  // No credential at all: the clone is anonymous and sees exactly what an
  // unauthenticated request sees. Only GitHub can be asked this cheaply.
  if (repo.provider !== "github") return null;
  try {
    await checkRepoVisible(null, full, AbortSignal.timeout(CHECK_TIMEOUT_MS));
    return null;
  } catch (e) {
    // ONLY a 404 counts here. Unauthenticated GitHub answers 403 for rate
    // limiting, which is a statement about us, not about this repository - and
    // this instance is known to exhaust that limit.
    const is404 = /\(404\)/.test(e instanceof Error ? e.message : String(e ?? ""));
    return is404
      ? `${full} is not visible to an anonymous clone - it is private or gone, and this app has no GitHub App linked. Link one under the app's Deploy source settings.`
      : null;
  }
}
