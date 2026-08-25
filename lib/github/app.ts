import "server-only";

import { createSign } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane";
import {
  assembleGithubApp,
  assembleGithubInstallation,
} from "../data/infra-rows";
import { decryptSecret } from "../crypto";
import { requireActiveTeamId, requireTeamWide } from "../membership";
import type { GithubApp, GithubInstallation } from "../types";

/**
 * GitHub App runtime: mints the JWTs and short-lived installation tokens that let
 * Deplo list and clone the repositories a user granted access to.
 */

const API = "https://api.github.com";
const UA = "Deplo";

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Signed RS256 JWT identifying the App itself (valid ≤10 min). */
function appJwt(app: GithubApp): string {
  const pem = decryptSecret(app.privateKeyEnc);
  if (!pem) throw new Error("GitHub App private key is unavailable");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // iat backdated 30s for clock skew; exp 9 min (< GitHub's 10 min ceiling).
  const payload = b64url(
    JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: app.appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = b64url(signer.sign(pem));
  return `${signingInput}.${signature}`;
}

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}
const tokenCache = new Map<string, CachedToken>();

async function findInstallation(
  installationId: string,
): Promise<{ app: GithubApp; install: GithubInstallation } | null> {
  const db = getDb();
  const installRows = await db
    .select()
    .from(githubInstallationTable)
    .where(eq(githubInstallationTable.id, installationId))
    .limit(1);
  if (!installRows[0]) return null;
  const install = assembleGithubInstallation(installRows[0]);
  const appRows = await db
    .select()
    .from(githubAppsTable)
    .where(eq(githubAppsTable.id, install.appId))
    .limit(1);
  if (!appRows[0]) return null;
  return { app: assembleGithubApp(appRows[0]), install };
}

export interface InstallationAccount {
  installationId: number;
  accountLogin: string;
  accountType: "User" | "Organization";
  avatarUrl: string;
}

/**
 * Resolve which connected App owns a numeric installation id and read its
 * account info, by trying each App's JWT until GitHub answers. Used by the
 * post-install setup redirect, which does not tell us which App was installed.
 */
export async function resolveInstallationAccount(
  numericInstallationId: number,
): Promise<{ app: GithubApp; account: InstallationAccount } | null> {
  const appRows = await getDb().select().from(githubAppsTable);
  const apps = appRows.map(assembleGithubApp);
  for (const app of apps) {
    try {
      const jwt = appJwt(app);
      const res = await fetch(
        `${API}/app/installations/${numericInstallationId}`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": UA,
            Authorization: `Bearer ${jwt}`,
          },
        },
      );
      if (!res.ok) continue;
      const json = (await res.json()) as {
        id: number;
        account: { login: string; type: string; avatar_url: string };
      };
      return {
        app,
        account: {
          installationId: json.id,
          accountLogin: json.account.login,
          accountType:
            json.account.type === "Organization" ? "Organization" : "User",
          avatarUrl: json.account.avatar_url,
        },
      };
    } catch {
      /* try the next app */
    }
  }
  return null;
}

/** The connected App registered under a given numeric GitHub App id. */
export async function findAppByAppId(appId: number): Promise<GithubApp | null> {
  const rows = await getDb()
    .select()
    .from(githubAppsTable)
    .where(eq(githubAppsTable.appId, appId))
    .limit(1);
  return rows[0] ? assembleGithubApp(rows[0]) : null;
}

async function githubFetch(
  path: string,
  init: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...rest } = init;
  return fetch(`${API}${path}`, {
    ...rest,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      Authorization: `Bearer ${token}`,
      ...(rest.headers ?? {}),
    },
  });
}

/**
 * A valid installation access token for the given Deplo installation id,
 * minting and caching one when needed. The token authorizes repo listing and
 * cloning for the repositories the user selected during installation.
 */
export async function getInstallationToken(
  installationId: string,
): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const found = await findInstallation(installationId);
  if (!found) throw new Error("GitHub installation not found");
  const jwt = appJwt(found.app);
  const res = await fetch(
    `${API}/app/installations/${found.install.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        Authorization: `Bearer ${jwt}`,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`Could not mint GitHub installation token (${res.status})`);
  }
  const json = (await res.json()) as { token: string; expires_at: string };
  tokenCache.set(installationId, {
    token: json.token,
    expiresAt: new Date(json.expires_at).getTime(),
  });
  return json.token;
}

export interface GithubRepoSummary {
  fullName: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  url: string;
  updatedAt: string;
}

/** Repositories the installation can access (paginated, capped). */
/**
 * Refuse an installation id that is not the active team's.
 */
async function assertInstallationInActiveTeam(
  installationId: string,
): Promise<void> {
  // A NARROWED API token (scoped to specific projects/apps) must not enumerate the
  // whole team's git inventory through the installation token — this is a team-level
  // browse, and a token creating an app passes its repo URL directly.
  await requireTeamWide("the team's git repositories");
  const teamId = await requireActiveTeamId();
  const row = (
    await getDb()
      .select({ id: githubInstallationTable.id })
      .from(githubInstallationTable)
      .innerJoin(
        githubAppsTable,
        eq(githubAppsTable.id, githubInstallationTable.appId),
      )
      .where(
        and(
          eq(githubInstallationTable.id, installationId),
          eq(githubAppsTable.teamId, teamId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new Error("GitHub installation not found");
}

export async function listInstallationRepos(
  installationId: string,
): Promise<GithubRepoSummary[]> {
  await assertInstallationInActiveTeam(installationId);
  const token = await getInstallationToken(installationId);
  const out: GithubRepoSummary[] = [];
  for (let page = 1; page <= 10; page++) {
    const res = await githubFetch(
      `/installation/repositories?per_page=100&page=${page}`,
      { token },
    );
    if (!res.ok) throw new Error(`GitHub repo list failed (${res.status})`);
    const json = (await res.json()) as {
      repositories: {
        full_name: string;
        name: string;
        private: boolean;
        default_branch: string;
        html_url: string;
        updated_at: string;
      }[];
    };
    for (const r of json.repositories) {
      out.push({
        fullName: r.full_name,
        name: r.name,
        private: r.private,
        defaultBranch: r.default_branch,
        url: r.html_url,
        updatedAt: r.updated_at,
      });
    }
    if (json.repositories.length < 100) break;
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

const OWNER_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Branch names for a repo accessible to the installation. */
export async function listRepoBranches(
  installationId: string,
  fullName: string,
): Promise<string[]> {
  if (!OWNER_REPO_RE.test(fullName)) throw new Error("Invalid repository");
  await assertInstallationInActiveTeam(installationId);
  const token = await getInstallationToken(installationId);
  const res = await githubFetch(`/repos/${fullName}/branches?per_page=100`, {
    token,
  });
  if (!res.ok) throw new Error(`GitHub branch list failed (${res.status})`);
  const json = (await res.json()) as { name: string }[];
  return json.map((b) => b.name);
}

/** GET a fixed api.github.com path, authenticating only when a token is given
 * (public repos can be read unauthenticated, subject to GitHub's IP rate
 * limit). Same pinned host + headers as {@link githubFetch}; no SSRF surface. */
async function githubGet(
  path: string,
  token: string | null,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${API}${path}`, {
    signal,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": UA,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
}

/**
 * Whether a repository is visible to an installation - or, with a null id, to an
 * anonymous caller, which is exactly what a credential-less clone gets.
 */
export async function checkRepoVisible(
  installationId: string | null,
  fullName: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!OWNER_REPO_RE.test(fullName)) throw new Error("Invalid repository");
  const token = installationId
    ? await getInstallationToken(installationId)
    : null;
  const res = await githubGet(`/repos/${fullName}`, token, signal);
  if (!res.ok) throw new Error(`GitHub repo check failed (${res.status})`);
}

/** A single blob entry from a repo's recursive git tree. */
export interface RepoTreeBlob {
  /** Repo-root-relative POSIX path. */
  path: string;
  /** Byte size of the blob. */
  size: number;
  /** The blob's git object SHA, for {@link fetchRepoBlob}. */
  sha: string;
}

/**
 * The recursive git tree of a GitHub repo at a ref (branch name, or "HEAD" for the
 * default branch), as a flat list of blob entries.
 */
export async function listRepoTree(
  fullName: string,
  ref: string,
  installationId: string | null,
): Promise<RepoTreeBlob[]> {
  if (!OWNER_REPO_RE.test(fullName)) return [];
  const token = installationId
    ? await getInstallationToken(installationId).catch(() => null)
    : null;
  const res = await githubGet(
    `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    token,
  ).catch(() => null);
  if (!res || !res.ok) return [];
  const json = (await res.json().catch(() => null)) as {
    tree?: { path: string; type: string; size?: number; sha: string }[];
  } | null;
  return (json?.tree ?? [])
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => ({ path: e.path, size: e.size ?? 0, sha: e.sha }));
}

/**
 * Fetch a single git blob's raw bytes by SHA, or null on any failure. Best-effort;
 * never throws.
 */
export async function fetchRepoBlob(
  fullName: string,
  sha: string,
  installationId: string | null,
): Promise<Buffer | null> {
  if (!OWNER_REPO_RE.test(fullName) || !/^[0-9a-f]{40}$/i.test(sha))
    return null;
  const token = installationId
    ? await getInstallationToken(installationId).catch(() => null)
    : null;
  const res = await githubGet(
    `/repos/${fullName}/git/blobs/${sha}`,
    token,
  ).catch(() => null);
  if (!res || !res.ok) return null;
  const json = (await res.json().catch(() => null)) as {
    content?: string;
    encoding?: string;
  } | null;
  if (!json || json.encoding !== "base64" || typeof json.content !== "string") {
    return null;
  }
  return Buffer.from(json.content, "base64");
}

/**
 * Clone URL for a repo, embedding a fresh installation token when one is given
 * (private repos). Returns the original URL unchanged for public repos / plain
 * Git sources. The token is short-lived and only ever used server-side.
 */
export async function installationCloneUrl(
  repoUrl: string,
  installationId: string | null,
): Promise<string> {
  if (!installationId) return repoUrl;
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return repoUrl;
  }
  if (parsed.hostname !== "github.com") return repoUrl;
  const token = await getInstallationToken(installationId);
  const path = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!OWNER_REPO_RE.test(path)) return repoUrl;
  return `https://x-access-token:${token}@github.com/${path}.git`;
}

/* ------------------------------------------------------------------ */
/* Pull requests (previews)                                            */
/* ------------------------------------------------------------------ */

/**
 * What a connected GitHub App can actually do — read live from GitHub, never
 * stored, because the operator fixes it on github.com and a cached answer would go
 * stale the moment they did.
 */
export interface GithubAppCapabilities {
  events: string[];
  permissions: Record<string, string>;
  /** Deliveries for `pull_request` arrive at all. */
  hasPullRequestEvent: boolean;
  /** Deplo may post/update the preview comment. */
  canWritePullRequests: boolean;
  /** Both of the above — the gate the Pull requests page reads. */
  previewReady: boolean;
  /** Deep link to THIS App's permissions page (not its public page). */
  settingsUrl: string;
  ownerLogin: string;
}

interface CachedCapabilities {
  value: GithubAppCapabilities;
  expiresAt: number;
}
const capabilitiesCache = new Map<string, CachedCapabilities>();
const CAPABILITIES_TTL_MS = 60_000;

/**
 * The App's declared events + permissions, cached for a minute so an RSC render
 * that asks once per app doesn't spend a round-trip each time.
 */
export async function readAppCapabilities(
  appDbId: string,
): Promise<GithubAppCapabilities | null> {
  const cached = capabilitiesCache.get(appDbId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const rows = await getDb()
      .select()
      .from(githubAppsTable)
      .where(eq(githubAppsTable.id, appDbId))
      .limit(1);
    if (!rows[0]) return null;
    const app = assembleGithubApp(rows[0]);
    const res = await fetch(`${API}/app`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": UA,
        Authorization: `Bearer ${appJwt(app)}`,
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      slug?: string;
      events?: string[];
      permissions?: Record<string, string>;
      owner?: { login?: string; type?: string };
    };
    const events = json.events ?? [];
    const permissions = json.permissions ?? {};
    const ownerLogin = json.owner?.login ?? "";
    const slug = json.slug ?? app.slug;
    // The App's PUBLIC page (`/apps/<slug>`) has no permissions UI — the owner's
    // settings page is the only place these can be changed.
    const settingsUrl =
      json.owner?.type === "Organization" && ownerLogin
        ? `https://github.com/organizations/${ownerLogin}/settings/apps/${slug}/permissions`
        : `https://github.com/settings/apps/${slug}/permissions`;
    const hasPullRequestEvent = events.includes("pull_request");
    const canWritePullRequests = permissions.pull_requests === "write";
    const value: GithubAppCapabilities = {
      events,
      permissions,
      hasPullRequestEvent,
      canWritePullRequests,
      previewReady: hasPullRequestEvent && canWritePullRequests,
      settingsUrl,
      ownerLogin,
    };
    capabilitiesCache.set(appDbId, {
      value,
      expiresAt: Date.now() + CAPABILITIES_TTL_MS,
    });
    return value;
  } catch {
    return null;
  }
}

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  /** `owner/name` of the head repo; null when the fork was deleted. */
  headRepo: string | null;
  /** The head repo's clone URL — a fork's ref does not exist on the base repo. */
  headCloneUrl: string | null;
  fromFork: boolean;
  draft: boolean;
  authorLogin: string;
  htmlUrl: string;
  updatedAt: string;
}

/** Shape one pull request payload — shared by the list and the single fetch. */
function toPullRequestSummary(
  p: RawPullRequest,
  baseRepo: string,
): GithubPullRequestSummary {
  const headRepo = p.head?.repo?.full_name ?? null;
  return {
    number: p.number,
    title: p.title ?? "",
    headRef: p.head?.ref ?? "",
    baseRef: p.base?.ref ?? "",
    headSha: p.head?.sha ?? "",
    headRepo,
    headCloneUrl: p.head?.repo?.clone_url ?? null,
    // NOT `head.repo.fork`: a pull request from an unrelated repository in the
    // same organisation has `fork: false` and is every bit as untrusted. The
    // question is only ever "is the head somewhere I control".
    fromFork: !headRepo || headRepo !== baseRepo,
    draft: Boolean(p.draft),
    authorLogin: p.user?.login ?? "",
    htmlUrl: p.html_url ?? "",
    updatedAt: p.updated_at ?? "",
  };
}

interface RawPullRequest {
  number: number;
  title?: string;
  draft?: boolean;
  state?: string;
  merged?: boolean;
  html_url?: string;
  updated_at?: string;
  user?: { login?: string };
  head?: {
    ref?: string;
    sha?: string;
    repo?: { full_name?: string; clone_url?: string } | null;
  };
  base?: { ref?: string };
}

/**
 * Open pull requests on a repo, most recently updated first. That is what makes
 * the manual "Deploy a pull request" flow work before anyone upgrades anything.
 */
export async function listOpenPullRequests(
  installationId: string,
  fullName: string,
): Promise<GithubPullRequestSummary[]> {
  if (!OWNER_REPO_RE.test(fullName)) throw new Error("Invalid repository");
  const token = await getInstallationToken(installationId);
  const res = await githubFetch(
    `/repos/${fullName}/pulls?state=open&per_page=100&sort=updated&direction=desc`,
    { token },
  );
  if (!res.ok)
    throw new Error(`GitHub pull request list failed (${res.status})`);
  const json = (await res.json()) as RawPullRequest[];
  return json.map((p) => toPullRequestSummary(p, fullName));
}

/** One pull request's current state — the reaper's missed-`closed` safety net.
 *  Non-throwing: an unreachable GitHub means "don't know", never "closed". */
export async function getPullRequestState(
  installationId: string,
  fullName: string,
  number: number,
): Promise<"open" | "closed" | null> {
  if (!OWNER_REPO_RE.test(fullName)) return null;
  try {
    const token = await getInstallationToken(installationId);
    const res = await githubFetch(`/repos/${fullName}/pulls/${number}`, {
      token,
    });
    if (res.status === 404) return "closed"; // deleted repo/PR — nothing to keep alive
    if (!res.ok) return null;
    const json = (await res.json()) as RawPullRequest;
    return json.state === "closed" ? "closed" : "open";
  } catch {
    return null;
  }
}

/**
 * Create or update Deplo's ONE sticky comment on a pull request. NEVER throws and
 * never rejects: a GitHub failure must not fail a deploy.
 */
export async function upsertPullRequestComment(opts: {
  installationId: string;
  /** `owner/name` of the BASE repo. */
  fullName: string;
  prNumber: number;
  commentId: number | null;
  body: string;
}): Promise<number | null> {
  const { installationId, fullName, prNumber, body } = opts;
  if (!OWNER_REPO_RE.test(fullName)) return null;
  try {
    const token = await getInstallationToken(installationId);
    if (opts.commentId) {
      const res = await githubFetch(
        `/repos/${fullName}/issues/comments/${opts.commentId}`,
        {
          token,
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body }),
        },
      );
      if (res.ok) return opts.commentId;
      // Anything other than "it's gone" is transient — keep the id and retry on
      // the next transition rather than posting a duplicate.
      if (res.status !== 404 && res.status !== 410) return opts.commentId;
    }
    const created = await githubFetch(
      `/repos/${fullName}/issues/${prNumber}/comments`,
      {
        token,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!created.ok) {
      // A 403 here is the App missing `pull_requests: write`. The Pull requests
      // page already surfaces that, so a log line is honest rather than lossy.
      console.warn(
        `[deplo-pr-comment] could not comment on ${fullName}#${prNumber} (${created.status})`,
      );
      return null;
    }
    const json = (await created.json()) as { id?: number };
    return json.id ?? null;
  } catch (e) {
    console.warn(
      `[deplo-pr-comment] ${fullName}#${prNumber}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return null;
  }
}
