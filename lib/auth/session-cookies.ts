import "server-only";

import { cookies, headers } from "next/headers";
import { authRequestHeaders } from "./request-headers";
import { ACTIVE_TEAM_COOKIE, ACTIVE_TEAM_TTL_SECONDS } from "../team-path";
import {
  sessionCookieNames,
  SECURE_COOKIE_PREFIX,
  SESSION_TTL_SECONDS,
} from "./better-auth";
import { cookiesAreSecure, requestIsHttps } from "../public-url";

// setActiveTeamCookie lands a new account on an active team, without the circular
// import that calling `setActiveTeam` from here would need.
export async function setActiveTeamCookie(teamId: string) {
  const store = await cookies();
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    // Per REQUEST, not per instance: on the panel's own IP address, which is
    // plain http, a `Secure` cookie is one the browser drops - and this one
    // carries the active team.
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

// authHeaders is this request's session metadata (user agent + IP chain) plus its cookies.
export async function authHeaders(): Promise<Headers> {
  let request: Headers | null = null;
  try {
    request = await headers();
  } catch {
    /* no request scope */
  }
  let cookie = "";
  try {
    const store = await cookies();
    cookie = store
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } catch {
    /* no request scope */
  }
  let https = false;
  try {
    https = await requestIsHttps();
  } catch {
    /* no request scope */
  }
  return authRequestHeaders(request, cookie, { twinCookieNames: !https });
}

// keepAuthCookiesUsableOverHttp re-issues Better Auth's fresh cookies without
// `Secure` when this request did not arrive over https.
export async function keepAuthCookiesUsableOverHttp(): Promise<void> {
  if (!cookiesAreSecure()) return;
  if (await requestIsHttps()) return;
  const secureSessionCookie = sessionCookieNames()[1];
  const store = await cookies();
  for (const c of store.getAll()) {
    if (!c.name.startsWith(SECURE_COOKIE_PREFIX)) continue;
    store.set(c.name.slice(SECURE_COOKIE_PREFIX.length), c.value, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      ...(c.name === secureSessionCookie
        ? { maxAge: SESSION_TTL_SECONDS }
        : {}),
    });
    store.delete(c.name);
  }
}
