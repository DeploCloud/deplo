// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { installationCloneUrl } from "../github/app";
import { readGitCredential } from "../data/git-connections";
import type { GitRepo } from "../types";

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
