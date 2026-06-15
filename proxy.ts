import { NextResponse, type NextRequest } from "next/server";

/**
 * Deplo proxy (Next.js 16 replacement for middleware).
 *
 * Responsibilities:
 *  - Generate a per-request CSP nonce and attach a strict Content-Security-Policy.
 *  - Set hardening response headers.
 *  - Optimistic auth redirect (presence-only cookie check). Real verification
 *    happens in layouts (requireUser) and the data layer (assertUser), per
 *    Next.js guidance — the proxy must not be the sole auth gate.
 *
 * Note: runs in the Edge runtime, so it must avoid node:crypto. It only checks
 * cookie presence; signature verification is done server-side downstream.
 */

const SESSION_COOKIE = "deplo_session";
const PUBLIC_PATHS = ["/login", "/signup"];

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
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    isHttps ? `upgrade-insecure-requests` : ``,
  ]
    .filter(Boolean)
    .join("; ")
    .trim();

  // ---- Optimistic auth redirect -------------------------------------------
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
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
    "camera=(), microphone=(), geolocation=(), browsing-topics=()"
  );
  if (isHttps) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
  }
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|install).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
