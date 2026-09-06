import "server-only";

import { installationCloneUrl } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import { assertSafeOutboundHost, assertSafeOutboundUrl } from "../outbound-url";
import type { GitRepo } from "../types";

/**
 * The outbound guard for a repository address the owning agent will clone AS
 * TYPED (no installation, no connection): http(s) and ssh/scp forms alike, so a
 * repository cannot be a way to dial the fleet's own addresses. Instance admins
 * may name a private host, as they may for a git connection.
 */
export async function assertCloneTargetSafe(
  url: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<void> {
  const raw = url.trim();
  if (!raw) return;
  // A token in the address is stored and shown as typed - at the view floor.
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*:[^/?#]*@/i.test(raw))
    throw new Error("Put the token in a git connection, not in the address");
  if (opts.allowPrivate) return;
  const scp = /^[\w.-]+@([^:/]+):/.exec(raw);
  if (scp) {
    await assertSafeOutboundHost(scp[1], "The repository address");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The repository address must be a valid URL");
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    await assertSafeOutboundUrl(raw, "The repository address", {
      allowHttp: true,
    });
    return;
  }
  if (parsed.protocol === "ssh:" || parsed.protocol === "git:") {
    await assertSafeOutboundHost(parsed.hostname, "The repository address");
    return;
  }
  throw new Error("The repository address must be an http(s) or ssh URL");
}

/**
 * The URL the deploy agent actually clones - the one place that decides how a
 * repository is authenticated.
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
  // Bind the credential to the connection's OWN host.
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
 * The URL a pull request preview clones when the head lives in a FORK. Two things
 * this exists to get right, and both were wrong while
 * `app_previews.head_clone_url` was recorded and then never read: 1.
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
