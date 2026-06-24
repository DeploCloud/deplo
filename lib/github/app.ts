import "server-only";

import { createSign } from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane";
import { assembleGithubApp, assembleGithubInstallation } from "../data/infra-rows";
import { decryptSecret } from "../crypto";
import type { GithubApp, GithubInstallation } from "../types";

/**
 * GitHub App runtime: mints the JWTs and short-lived installation tokens that
 * let Deplo list and clone the repositories a user granted access to.
 *
 * Security:
 *  - The App private key (PEM) and secrets live encrypted at rest; they are
 *    decrypted only here, server-side, and never logged or returned to clients.
 *  - Installation tokens are short-lived (≈1h) and cached in memory only.
 *  - All calls target the fixed api.github.com host (no SSRF surface).
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
export async function getInstallationToken(installationId: string): Promise<string> {
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
export async function listInstallationRepos(
  installationId: string,
): Promise<GithubRepoSummary[]> {
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
  const token = await getInstallationToken(installationId);
  const res = await githubFetch(
    `/repos/${fullName}/branches?per_page=100`,
    { token },
  );
  if (!res.ok) throw new Error(`GitHub branch list failed (${res.status})`);
  const json = (await res.json()) as { name: string }[];
  return json.map((b) => b.name);
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
