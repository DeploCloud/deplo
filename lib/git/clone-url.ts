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
  // The WHATWG URL serializer percent-encodes userinfo, so a token containing
  // "@", ":" or "/" survives the round trip.
  parsed.username = cred.username;
  parsed.password = cred.token;
  return parsed.toString();
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
