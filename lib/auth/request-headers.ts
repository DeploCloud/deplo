// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The header set deplo hands to Better Auth's server API. Pure (no `next/headers`)
 * so the selection can be tested, and it needs to be, because BOTH directions of
 * this list are load-bearing and both fail silently.
 */

/** Exactly what Better Auth reads off the request when creating a session. */
export const SESSION_METADATA_HEADERS = [
  "user-agent",
  // The IP chain, in the order `advanced.ipAddress.ipAddressHeaders` lists them.
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
] as const;

/**
 * Build the headers for a Better Auth server call: the session metadata from the
 * live request, plus the cookie string the caller resolved.
 */
export function authRequestHeaders(
  request: Headers | null | undefined,
  cookie: string,
): Headers {
  const out = new Headers();
  if (request)
    for (const name of SESSION_METADATA_HEADERS) {
      const value = request.get(name);
      if (value) out.set(name, value);
    }
  if (cookie) out.set("cookie", withBothCookieNames(cookie));
  return out;
}

/** Better Auth's cookie prefix on this instance (`advanced.cookiePrefix`). */
const AUTH_COOKIE_PREFIX = "deplo.";
const SECURE_PREFIX = "__Secure-";

/**
 * Offer every Better Auth cookie under BOTH the plain and the `__Secure-` name. A
 * deplo answers on two addresses at once: its panel address, usually https, and
 * its server's own `http://<ip>:3000`, the way back in when the domain breaks.
 */
export function withBothCookieNames(cookie: string): string {
  if (!cookie.includes(AUTH_COOKIE_PREFIX)) return cookie;
  const pairs = cookie.split("; ").filter(Boolean);
  const names = new Set(pairs.map((p) => p.slice(0, p.indexOf("="))));
  const extra: string[] = [];
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq);
    const twin = name.startsWith(SECURE_PREFIX)
      ? name.slice(SECURE_PREFIX.length)
      : `${SECURE_PREFIX}${name}`;
    const bare = name.startsWith(SECURE_PREFIX)
      ? name.slice(SECURE_PREFIX.length)
      : name;
    if (!bare.startsWith(AUTH_COOKIE_PREFIX) || names.has(twin)) continue;
    names.add(twin);
    extra.push(`${twin}=${pair.slice(eq + 1)}`);
  }
  return extra.length ? `${cookie}; ${extra.join("; ")}` : cookie;
}
