import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { githubUserTokens } from "../db/schema/control-plane/integrations";
import {
  decryptSecret,
  decryptSecretOrThrow,
  encryptSecret,
  signState,
  verifyState,
} from "../crypto";
import { newId, nowIso } from "../ids";
import { safeReturnPath } from "../utils";
import type { GithubApp } from "../types/git";

const UA = "Deplo";
const STATE_KIND = "github-user";

export function githubCallbackUrl(publicBase: string): string {
  return `${publicBase.replace(/\/+$/, "")}/api/github/callback`;
}

export function userAuthorizeUrl(opts: {
  app: Pick<GithubApp, "id" | "clientId">;
  userId: string;
  returnTo: string | null;
  publicBase: string;
}): string {
  const state = signState(
    JSON.stringify({
      k: STATE_KIND,
      u: opts.userId,
      a: opts.app.id,
      r: safeReturnPath(opts.returnTo),
    }),
  );
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", opts.app.clientId);
  url.searchParams.set("redirect_uri", githubCallbackUrl(opts.publicBase));
  url.searchParams.set("state", state);
  return url.toString();
}

// null = not a sign-in this user started (a manifest callback, a stale or forged state).
export function readUserAuthorizeState(
  token: string | null | undefined,
  userId: string,
): { appId: string; returnTo: string | null } | null {
  const data = verifyState(token ?? undefined);
  if (!data?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(data) as {
      k?: string;
      u?: string;
      a?: string;
      r?: string | null;
    };
    if (parsed.k !== STATE_KIND || parsed.u !== userId || !parsed.a)
      return null;
    return { appId: parsed.a, returnTo: safeReturnPath(parsed.r) };
  } catch {
    return null;
  }
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  app: GithubApp,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": UA,
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: decryptSecretOrThrow(
        app.clientSecretEnc,
        "The GitHub App's client secret",
      ),
      ...params,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub sign-in failed (${res.status})`);
  const json = (await res.json()) as TokenResponse;
  if (json.error || !json.access_token)
    throw new Error(
      json.error_description || json.error || "GitHub sign-in failed",
    );
  return json;
}

function expiry(seconds: number | undefined): string | null {
  return seconds ? new Date(Date.now() + seconds * 1000).toISOString() : null;
}

async function githubLogin(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": UA,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub sign-in failed (${res.status})`);
  return ((await res.json()) as { login?: string }).login ?? "";
}

async function store(
  app: GithubApp,
  userId: string,
  t: TokenResponse,
  login: string,
): Promise<void> {
  const values = {
    githubLogin: login,
    tokenEnc: encryptSecret(t.access_token!),
    expiresAt: expiry(t.expires_in),
    refreshTokenEnc: t.refresh_token ? encryptSecret(t.refresh_token) : null,
    refreshExpiresAt: expiry(t.refresh_token_expires_in),
  };
  await getDb()
    .insert(githubUserTokens)
    .values({
      id: newId("ghut"),
      appId: app.id,
      userId,
      createdAt: nowIso(),
      ...values,
    })
    .onConflictDoUpdate({
      target: [githubUserTokens.appId, githubUserTokens.userId],
      set: values,
    });
}

export async function completeUserAuthorize(
  app: GithubApp,
  userId: string,
  code: string,
  publicBase: string,
): Promise<string> {
  const t = await tokenRequest(app, {
    code,
    redirect_uri: githubCallbackUrl(publicBase),
  });
  const login = await githubLogin(t.access_token!);
  await store(app, userId, t, login);
  return login;
}

export interface GithubUserSignIn {
  login: string;
  token: string;
}

// The person's GitHub token for this app, renewed when it has expired; null = sign in again.
export async function userToken(
  app: GithubApp,
  userId: string,
): Promise<GithubUserSignIn | null> {
  const row = (
    await getDb()
      .select()
      .from(githubUserTokens)
      .where(
        and(
          eq(githubUserTokens.appId, app.id),
          eq(githubUserTokens.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  const fresh =
    !row.expiresAt || new Date(row.expiresAt).getTime() - 60_000 > Date.now();
  if (fresh) {
    const token = decryptSecret(row.tokenEnc);
    return token ? { login: row.githubLogin, token } : null;
  }
  const refresh = row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) : "";
  if (
    !refresh ||
    (row.refreshExpiresAt &&
      new Date(row.refreshExpiresAt).getTime() < Date.now())
  )
    return null;
  try {
    const t = await tokenRequest(app, {
      grant_type: "refresh_token",
      refresh_token: refresh,
    });
    await store(app, userId, t, row.githubLogin);
    return { login: row.githubLogin, token: t.access_token! };
  } catch {
    return null;
  }
}

export async function hasUserToken(
  appId: string,
  userId: string,
): Promise<string | null> {
  const row = (
    await getDb()
      .select({
        login: githubUserTokens.githubLogin,
        refreshExpiresAt: githubUserTokens.refreshExpiresAt,
        expiresAt: githubUserTokens.expiresAt,
        hasRefresh: githubUserTokens.refreshTokenEnc,
      })
      .from(githubUserTokens)
      .where(
        and(
          eq(githubUserTokens.appId, appId),
          eq(githubUserTokens.userId, userId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  const now = Date.now();
  const live =
    !row.expiresAt ||
    new Date(row.expiresAt).getTime() > now ||
    (row.hasRefresh &&
      (!row.refreshExpiresAt ||
        new Date(row.refreshExpiresAt).getTime() > now));
  return live ? row.login : null;
}
