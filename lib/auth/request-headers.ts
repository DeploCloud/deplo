/**
 * The header set deplo hands to Better Auth's server API.
 *
 * Pure (no `next/headers`) so the selection can be tested — and it needs to be,
 * because BOTH directions of this list are load-bearing and both fail silently.
 *
 * What must be forwarded: `internalAdapter.createSession` stamps the new session
 * row with `userAgent` and the IP taken from these headers. Forward neither and
 * every row in Settings → Security reads "Unknown device" with no IP — a devices
 * table that cannot tell you which device, which is worse than not having one.
 *
 * What must NOT be forwarded: `origin`, `referer` and `host`. Better Auth runs an
 * origin check against `trustedOrigins`, which defaults to `baseURL`. deplo is
 * reached on whatever host the operator points at it — a bare IP, a nip.io name,
 * a custom domain — so forwarding an origin that disagrees with `DEPLO_PUBLIC_URL`
 * would turn every login on a secondary host into a rejection. The request has
 * already been authenticated by the time we call the server API; we are not
 * relaying an untrusted browser call, we are calling a library in-process.
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
 *
 * `cookie` is passed in rather than read from `request` on purpose. Next's cookie
 * STORE reflects writes made earlier in the same request, so a `getSession()`
 * straight after a `signInEmail()` sees the session that was just minted; the raw
 * request headers still carry the pre-login cookie and would not.
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
 * Offer every Better Auth cookie under BOTH the plain and the `__Secure-` name.
 *
 * A deplo answers on two addresses at once: its panel address, usually https,
 * and its server's own `http://<ip>:3000`, the way back in when the domain
 * breaks. A browser refuses a `Secure` cookie on the second one, so a session
 * opened there is stored under the plain name - while `auth.api.getSession`
 * looks the session up under EXACTLY one name, computed once from
 * `useSecureCookies` when the auth instance is built (better-auth
 * `cookies/index.mjs` → `createCookieGetter`). Without this, a session minted on
 * the rescue address passes the proxy's presence check (proxy.ts accepts both
 * names) and then resolves to nobody in the layout: a redirect loop back to
 * /login rather than a panel.
 *
 * Additive and idempotent: a name already present is never overwritten, so on
 * the canonical address this changes nothing. Only Better Auth's own cookies are
 * twinned - `deplo_team` and `theme` are deplo's and are read by their one name.
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
