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

export async function setActiveTeamCookie(teamId: string) {
  const store = await cookies();
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

export async function authHeaders(): Promise<Headers> {
  let request: Headers | null = null;
  try {
    request = await headers();
  } catch {}
  let cookie = "";
  try {
    const store = await cookies();
    cookie = store
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } catch {}
  let https = false;
  try {
    https = await requestIsHttps();
  } catch {}
  return authRequestHeaders(request, cookie, { twinCookieNames: !https });
}

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
