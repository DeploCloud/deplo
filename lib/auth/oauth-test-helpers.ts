import { createHash, randomBytes } from "node:crypto";

import { requireAuth } from "./better-auth";

/**
 * Drive the REAL OAuth flow in-process, through Better Auth's own handler.
 *
 * Named to dodge the `*.test.ts` glob. Nothing here fakes a token: register →
 * sign in → authorize → consent → exchange, exactly as claude.ai would, so the
 * strings these return are the ones a client would actually present. That
 * matters most for one contract that is invisible until it breaks — the plugin
 * strips its prefix BEFORE hashing, so `authenticateToken` must hash the bare
 * secret. A hand-inserted row would agree with whatever the code does and prove
 * nothing.
 *
 * Every helper returns raw strings so a test can deliberately misuse them: send
 * the refresh token as a bearer, replay a code, redeem against a different
 * redirect.
 */

/**
 * Requests are addressed to the instance's OWN public URL, not to localhost.
 *
 * Better Auth refuses a cookie-carrying POST from an origin that is not its
 * `baseURL` — which is the CSRF defence the consent screen relies on, so a test
 * that hit `http://localhost` would be proving the refusal rather than the flow.
 */
function base(): string {
  return process.env.DEPLO_PUBLIC_URL ?? "http://localhost";
}

/**
 * Every POST carries `Origin`, because Better Auth refuses a cookie-carrying
 * POST without one (`MISSING_OR_NULL_ORIGIN`) — the browser-side CSRF defence.
 * deplo's own consent call reaches the endpoint IN-PROCESS, where there is no
 * request and so no origin check; a browser sends this header for real.
 */
function call(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (init?.method === "POST") headers.set("origin", base());
  return requireAuth().handler(
    new Request(`${base()}/api/auth${path}`, { ...init, headers }),
  );
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
}

/** RFC 7591 dynamic registration, unauthenticated — the claude.ai path. */
export async function registerClient(
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call("/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Test AI client",
      redirect_uris: ["https://client.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...overrides,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body };
}

/** Sign in over HTTP and return the cookie string a browser would then send. */
export async function signIn(email: string, password: string): Promise<string> {
  const res = await call("/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookies) throw new Error(`sign-in produced no cookie (${res.status})`);
  return cookies;
}

export interface AuthorizeResult {
  status: number;
  /** Where the authorize leg sent the browser. */
  location: string | null;
  /** The signed authorization query the consent page is handed. */
  oauthQuery: string | null;
}

export async function authorize(
  cookie: string,
  params: Record<string, string>,
): Promise<AuthorizeResult> {
  const qs = new URLSearchParams(params).toString();
  const res = await call(`/oauth2/authorize?${qs}`, {
    method: "GET",
    headers: { cookie },
    redirect: "manual",
  });
  const location = res.headers.get("location");
  const oauthQuery = location?.includes("?")
    ? location.slice(location.indexOf("?") + 1)
    : null;
  return { status: res.status, location, oauthQuery };
}

/** Approve or decline. Returns the URL the browser is sent to next. */
export async function consent(
  cookie: string,
  body: { accept: boolean; scope?: string; oauth_query?: string },
): Promise<{ status: number; url: string | null }> {
  const res = await call("/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string };
  return { status: res.status, url: json.url ?? null };
}

export async function exchange(
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, string> }> {
  const res = await call("/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  return { status: res.status, body };
}

/** Trade a refresh token for a fresh access token, as a client does hourly. */
export async function refresh(
  refreshToken: string,
  clientId: string,
  resource?: string,
): Promise<{ status: number; body: Record<string, string> }> {
  return exchange({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...(resource ? { resource } : {}),
  });
}

export interface FullFlowResult {
  clientId: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  code: string;
  verifier: string;
  redirectUri: string;
}

/**
 * Register → sign in → authorize → consent → exchange, and hand back every
 * credential the flow produced.
 */
export async function fullFlow(opts: {
  email: string;
  password: string;
  resource?: string;
  scope?: string;
}): Promise<FullFlowResult> {
  const reg = await registerClient();
  const clientId = String(reg.body.client_id ?? "");
  if (!clientId) throw new Error(`registration failed: ${JSON.stringify(reg)}`);

  const cookie = await signIn(opts.email, opts.password);
  const { verifier, challenge } = pkcePair();
  const redirectUri = "https://client.test/callback";
  const authorizeParams: Record<string, string> = {
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: opts.scope ?? "openid offline_access",
    state: "st",
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(opts.resource ? { resource: opts.resource } : {}),
  };
  const authorized = await authorize(cookie, authorizeParams);
  const approved = await consent(cookie, {
    accept: true,
    ...(authorized.oauthQuery ? { oauth_query: authorized.oauthQuery } : {}),
  });
  if (!approved.url) throw new Error(`consent failed (${approved.status})`);
  const code = new URL(approved.url).searchParams.get("code");
  if (!code) throw new Error(`no code in ${approved.url}`);

  const token = await exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
    ...(opts.resource ? { resource: opts.resource } : {}),
  });
  if (!token.body.access_token)
    throw new Error(`token exchange failed: ${JSON.stringify(token)}`);

  return {
    clientId,
    accessToken: token.body.access_token,
    refreshToken: token.body.refresh_token ?? null,
    idToken: token.body.id_token ?? null,
    code,
    verifier,
    redirectUri,
  };
}
