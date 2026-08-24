import "server-only";

import { installationCloneUrl } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import type { GitRepo } from "../types";

/**
 * The URL the deploy agent actually clones - the one place that decides how a
 * repository is authenticated.
 *
 * Three cases, in order:
 *  - a GitHub App installation mints a fresh ~1h token (unchanged behaviour);
 *  - a {@link GitConnection} embeds its stored token as basic auth;
 *  - anything else clones anonymously, which is what a bare "Repository URL" is.
 *
 * The credential goes in the URL's userinfo rather than the proto's `GitSource.
 * token` because the agent lifts userinfo into an `Authorization: Basic` header
 * before running git (`internal/server/git.go`), so it never reaches argv,
 * `/proc/<pid>/cmdline` or the build log. That also means adding providers took
 * no proto change and no agent release.
 */
export async function resolveCloneUrl(repo: GitRepo): Promise<string> {
  if (repo.installationId) {
    return installationCloneUrl(repo.url, repo.installationId);
  }
  if (!repo.connectionId) return repo.url;

  const cred = await readGitCredential(repo.connectionId);
  if (!cred) return repo.url;

  let parsed: URL;
  try {
    parsed = new URL(repo.url);
  } catch {
    // An scp-style remote (git@host:owner/repo.git) has nowhere to put basic
    // auth. Hand it over untouched rather than mangling it: it either clones
    // anonymously or fails with git's own message.
    return repo.url;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return repo.url;
  }
  // Bind the credential to the connection's OWN host. `repo.url` and the
  // `connectionId` are chosen independently by a member who needs neither
  // `manage_git` nor any secret-reveal capability (`scopeRepoCredentials` checks
  // only that the connection is in their team), so without this a repo URL
  // pointing at an attacker's host would carry the connection's PAT there — the
  // agent lifts userinfo into an `Authorization: Basic` header. `baseUrl` is the
  // host repositories are served from (distinct from `apiBaseUrl`), so a clone
  // host that isn't it is not this connection's repo. Mismatch ⇒ clone
  // anonymously, exactly as the GitHub-App (`hostname !== "github.com"`) and fork
  // (`head.host !== base.host`) paths already do.
  let connHost: string;
  try {
    connHost = new URL(cred.baseUrl).host.toLowerCase();
  } catch {
    return repo.url; // a connection with no parseable base URL earns no token
  }
  if (parsed.host.toLowerCase() !== connHost) return repo.url;
  // The WHATWG URL serializer percent-encodes userinfo, so a token containing
  // "@", ":" or "/" survives the round trip.
  parsed.username = cred.username;
  parsed.password = cred.token;
  return parsed.toString();
}

/**
 * The URL a pull request preview clones when the head lives in a FORK.
 *
 * Two things this exists to get right, and both were wrong while
 * `app_previews.head_clone_url` was recorded and then never read:
 *
 *  1. **The fork's code is what builds.** The deploy used to clone the app's own
 *     repository at the fork's branch NAME, so a fork preview either failed
 *     outright or quietly built the BASE repo's branch of the same name. The
 *     approve button therefore promised a maintainer they had reviewed a diff
 *     that was never what ran - a security control that protected nothing.
 *  2. **No credential goes to it.** {@link resolveCloneUrl} embeds an
 *     installation token or a connection's PAT; a fork belongs to a stranger, so
 *     it is cloned ANONYMOUSLY. A private fork simply fails to clone, which is
 *     the correct outcome.
 *
 * The URL arrives inside a webhook body, so it is checked rather than trusted:
 * https only, no userinfo, and the same host as the app's own repository. Deplo
 * must not be talked into cloning `https://evil.test/x.git` by a `pull_request`
 * payload. Rebuilt from its parts so a query string or fragment cannot ride along.
 *
 * Pure, and it THROWS with the sentence the deploy log shows: a preview that
 * cannot say which code it would run must not run any.
 */
export function forkCloneUrl(
  baseRepoUrl: string,
  headCloneUrl: string,
): string {
  const fail = (why: string): never => {
    throw new Error(
      `This pull request comes from a fork and Deplo will not clone it: ${why}.`,
    );
  };
  let head: URL;
  try {
    head = new URL(headCloneUrl);
  } catch {
    return fail(
      headCloneUrl
        ? "its clone address is not a URL"
        : "no clone address was recorded for it. Close and reopen the pull request",
    );
  }
  if (head.protocol !== "https:") return fail("its clone address is not https");
  if (head.username || head.password)
    return fail("its clone address carries a credential");
  let base: URL | null = null;
  try {
    base = new URL(baseRepoUrl);
  } catch {
    base = null;
  }
  if (base && head.host !== base.host)
    return fail(`it is hosted on ${head.host}, not on ${base.host}`);
  return `${head.protocol}//${head.host}${head.pathname}`;
}

/**
 * A repo URL with any credential stripped, safe to print in a deploy log or a
 * DTO. Deploy logs are readable by anyone with `view_logs`, which is a much
 * wider set than the people allowed to manage the connection.
 */
export function redactCloneUrl(cloneUrl: string): string {
  try {
    const u = new URL(cloneUrl);
    u.username = "";
    u.password = "";
    return u.toString();
  } catch {
    return cloneUrl;
  }
}
