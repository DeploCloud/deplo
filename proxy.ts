import { NextResponse, type NextRequest } from "next/server";
import { templatesApiBase } from "@/templates/api-base";
import { GRAVATAR_ORIGINS } from "@/lib/apps/avatar-shared";
import { isWildcardDnsHost } from "@/lib/www-redirect";
import {
  ACTIVE_TEAM_COOKIE,
  ACTIVE_TEAM_TTL_SECONDS,
  TEAM_HEADER,
  teamSlugFromPath,
} from "@/lib/team-path";

/**
 * Deplo proxy (Next.js 16 replacement for middleware). Real verification happens
 * in layouts (requireUser) and the data layer (assertUser), per Next.js guidance
 * the proxy must not be the sole auth gate.
 */

// Better Auth's session cookie (ADR-0014).
const SESSION_COOKIES = ["deplo.session_token", "__Secure-deplo.session_token"];
// Paths reachable WITHOUT a session. `/register/<token>` is how a brand-new
// person self-registers an account + team from a single-use link, so it must be
// public, otherwise the proxy bounces them to /login before the page renders.
const PUBLIC_PATHS = ["/login", "/signup", "/setup", "/register"];

/**
 * Whether THIS request arrived over TLS. It also outlived turning HTTPS off from
 * the panel, because that moves the stored address and never the env var.
 */
function requestIsHttps(request: NextRequest): boolean {
  const forwarded = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwarded) return forwarded === "https";
  if (request.nextUrl.protocol === "https:") return true;
  const configured = process.env.DEPLO_PUBLIC_URL?.trim() ?? "";
  if (!configured.startsWith("https://")) return false;
  try {
    return new URL(configured).host === request.headers.get("host");
  } catch {
    return false;
  }
}

/** The host this request was made to, lower-cased and without its port. */
function hostOf(request: NextRequest): string {
  const raw = request.headers.get("host") ?? request.nextUrl.host;
  return raw.replace(/:\d+$/, "").toLowerCase();
}

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
  // Only force HTTPS upgrades when THIS request really came over TLS; see
  // requestIsHttps - an http://<ip> page that upgrades its own assets is a panel
  // with no CSS.
  const isHttps = requestIsHttps(request);
  // Template cards load their logos straight from the catalog service, so its
  // origin has to be allowed here or every one of them is blocked.
  let templatesOrigin = "";
  try {
    templatesOrigin = new URL(templatesApiBase()).origin;
  } catch {}
  // The takeover screen is served over http through the old panel's proxy and
  // asks its own https address whether it answers yet - same host, other scheme,
  // so a different origin to a browser.
  let ownOrigin = "";
  try {
    ownOrigin = new URL(process.env.DEPLO_PUBLIC_URL ?? "").origin;
  } catch {}
  const nonce = generateNonce();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      isDev ? " 'unsafe-eval'" : ""
    }`,
    // Browser push registers /sw.js. `worker-src` falls back to `script-src`,
    // where `'strict-dynamic'` makes `'self'` inert, so without this line the
    // service worker registration is refused outright.
    `worker-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    // Two remote image origins, for the same reason the template catalog's is allowed:
    // the panel does not proxy them, the browser fetches them. - Gravatar, for a person
    // who has never uploaded a picture.
    `img-src 'self' blob: data: ${GRAVATAR_ORIGINS.join(" ")} https://avatars.githubusercontent.com${
      templatesOrigin ? ` ${templatesOrigin}` : ""
    }`,
    `font-src 'self' data:`,
    `connect-src 'self'${ownOrigin ? ` ${ownOrigin}` : ""}`,
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
    // The query is dropped everywhere else on purpose (it can carry anything a link put
    // there).
    const back = pathname.startsWith("/oauth/")
      ? pathname + request.nextUrl.search
      : null;
    url.pathname = "/login";
    url.search = back ? `?next=${encodeURIComponent(back)}` : "";
    return NextResponse.redirect(url);
  }
  // Note: we intentionally do NOT redirect "has-cookie" users away from the auth
  // pages here.

  // ---- Headers -------------------------------------------------------------
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  // The team in the URL is the team the request operates in, and this header is
  // how it reaches lib/membership. Always set, so nothing a client sent gets in.
  const teamSlug = teamSlugFromPath(pathname);
  requestHeaders.set(TEAM_HEADER, teamSlug ?? "");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  // Keep "the last team visited" in step with the URL: it is what a bare `/` and
  // the REST routes (upload, log stream) have to agree with.
  if (teamSlug && request.cookies.get(ACTIVE_TEAM_COOKIE)?.value !== teamSlug) {
    response.cookies.set(ACTIVE_TEAM_COOKIE, teamSlug, {
      httpOnly: true,
      secure: isHttps,
      sameSite: "lax",
      path: "/",
      maxAge: ACTIVE_TEAM_TTL_SECONDS,
    });
  }
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
  // Six months, and deliberately WITHOUT `includeSubDomains; preload`. Never on
  // the generated host: no public CA issues for it, and HSTS is what takes the
  // browser's "Proceed anyway" away from a certificate warning.
  if (isHttps && !isWildcardDnsHost(hostOf(request))) {
    response.headers.set("Strict-Transport-Security", "max-age=15552000");
  }
  return response;
}

export const config = {
  matcher: [
    {
      // `.well-known` is excluded for the same reason `api` is: the OAuth discovery
      // documents (RFC 8414 / RFC 9728) are probed by a client that has no cookie yet and
      // no way to get one.
      // Prefetches are NOT excluded: they render RSC payloads, and one that
      // skipped this would resolve the team from the cookie, not the URL.
      source:
        "/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|robots.txt|install|uninstall).*)",
    },
  ],
};
