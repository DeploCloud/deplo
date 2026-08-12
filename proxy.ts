import { NextResponse, type NextRequest } from "next/server";

/**
 * Deplo proxy (Next.js 16 replacement for middleware).
 *
 * Responsibilities:
 *  - Generate a per-request CSP nonce and attach a strict Content-Security-Policy.
 *  - Set hardening response headers.
 *  - Optimistic auth redirect (presence-only cookie check). Real verification
 *    happens in layouts (requireUser) and the data layer (assertUser), per
 *    Next.js guidance  the proxy must not be the sole auth gate.
 *
 * Note: runs in the Edge runtime, so it must avoid node:crypto. It only checks
 * cookie presence; signature verification is done server-side downstream.
 */

// Better Auth's session cookie (ADR-0014). It carries the `__Secure-` prefix when
// the instance runs `useSecureCookies`, so BOTH names must be accepted here — an
// https instance that only checked the bare name would bounce every signed-in user
// straight back to /login. Duplicated from lib/auth/better-auth.ts rather than
// imported: the proxy runs in the Edge runtime and that module is `server-only`.
const SESSION_COOKIES = ["deplo.session_token", "__Secure-deplo.session_token"];
// Paths reachable WITHOUT a session. `/register/<token>` is how a brand-new
// person self-registers an account + team from a single-use link, so it must be
// public — otherwise the proxy bounces them to /login before the page renders.
const PUBLIC_PATHS = ["/login", "/signup", "/setup", "/register"];

function generateNonce(): string {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isDev = process.env.NODE_ENV === "development";
  // Only force HTTPS upgrades when the instance is actually served over TLS;
  // otherwise an http://<ip> deployment would try (and fail) to upgrade assets.
  const isHttps =
    (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://") ||
    request.headers.get("x-forwarded-proto") === "https";
  const nonce = generateNonce();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    // Browser push registers /sw.js. `worker-src` falls back to `script-src`,
    // where `'strict-dynamic'` makes `'self'` inert — so without this line the
    // service worker registration is refused outright.
    `worker-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // github.com is allowed so the one-click GitHub App manifest flow can POST
    // the app manifest to GitHub from the browser.
    `form-action 'self' https://github.com`,
    `frame-ancestors 'none'`,
    isHttps ? `upgrade-insecure-requests` : ``,
  ]
    .filter(Boolean)
    .join("; ")
    .trim();

  // ---- Optimistic auth redirect -------------------------------------------
  const hasSession = SESSION_COOKIES.some(
    (name) => !!request.cookies.get(name)?.value,
  );
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    // The query is dropped everywhere else on purpose (it can carry anything a
    // link put there). The OAuth consent screen is the one page whose query IS
    // the request: losing it strands someone mid-flow inside a third-party
    // product with no way back except starting over there.
    const back = pathname.startsWith("/oauth/")
      ? pathname + request.nextUrl.search
      : null;
    url.pathname = "/login";
    url.search = back ? `?next=${encodeURIComponent(back)}` : "";
    return NextResponse.redirect(url);
  }
  // Note: we intentionally do NOT redirect "has-cookie" users away from the
  // auth pages here. The proxy runs on the Edge runtime and cannot verify the
  // cookie signature, so trusting mere presence would trap users with an
  // expired/invalid session in a /login <-> / redirect loop. The (auth) layout
  // performs the real check (getCurrentUser) and redirects authenticated users
  // to the dashboard.

  // ---- Headers -------------------------------------------------------------
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  );
  // Private panel: never let any page enter a search index (belt-and-suspenders
  // with app/robots.ts and the `robots` metadata in app/layout.tsx).
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (isHttps) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }
  return response;
}

export const config = {
  matcher: [
    {
      // `.well-known` is excluded for the same reason `api` is: the OAuth
      // discovery documents (RFC 8414 / RFC 9728) are probed by a client that has
      // no cookie yet and no way to get one. Without this, every probe is a 302
      // to /login and no web AI client can connect to the MCP server at all.
      source:
        "/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|robots.txt|install|uninstall).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
