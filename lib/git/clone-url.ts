import "server-only";

import { installationCloneUrl } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import { assertSafeOutboundHost, assertSafeOutboundUrl } from "../outbound-url";
import type { GitRepo } from "../types/build";

export async function assertCloneTargetSafe(
  url: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<void> {
  const raw = url.trim();
  if (!raw) return;
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
    return repo.url;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return repo.url;
  }
  let connHost: string;
  try {
    connHost = new URL(cred.baseUrl).host.toLowerCase();
  } catch {
    return repo.url;
  }
  // Bind the credential to the connection's OWN host, or a repo URL pointing elsewhere would carry the token.
  if (parsed.host.toLowerCase() !== connHost) return repo.url;
  parsed.username = cred.username;
  parsed.password = cred.token;
  return parsed.toString();
}

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
