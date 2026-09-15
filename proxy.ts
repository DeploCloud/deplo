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

const SESSION_COOKIES = ["deplo.session_token", "__Secure-deplo.session_token"];
const PUBLIC_PATHS = ["/login", "/setup", "/register"];

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
  const isHttps = requestIsHttps(request);
  let templatesOrigin = "";
  try {
    templatesOrigin = new URL(templatesApiBase()).origin;
  } catch {}
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
    `worker-src 'self'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' blob: data: ${GRAVATAR_ORIGINS.join(" ")} https://avatars.githubusercontent.com${
      templatesOrigin ? ` ${templatesOrigin}` : ""
    }`,
    `font-src 'self' data:`,
    `connect-src 'self'${ownOrigin ? ` ${ownOrigin}` : ""}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self' https://github.com`,
    `frame-ancestors 'none'`,
    isHttps ? `upgrade-insecure-requests` : ``,
  ]
    .filter(Boolean)
    .join("; ")
    .trim();

  const hasSession = SESSION_COOKIES.some(
    (name) => !!request.cookies.get(name)?.value,
  );
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!hasSession && !isPublic) {
    const url = request.nextUrl.clone();
    const back = pathname.startsWith("/oauth/")
      ? pathname + request.nextUrl.search
      : null;
    url.pathname = "/login";
    url.search = back ? `?next=${encodeURIComponent(back)}` : "";
    return NextResponse.redirect(url);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const teamSlug = teamSlugFromPath(pathname);
  requestHeaders.set(TEAM_HEADER, teamSlug ?? "");

  const response = NextResponse.next({ request: { headers: requestHeaders } });
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
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  if (isHttps && !isWildcardDnsHost(hostOf(request))) {
    response.headers.set("Strict-Transport-Security", "max-age=15552000");
  }
  return response;
}

export const config = {
  matcher: [
    {
      source:
        "/((?!api|\\.well-known|_next/static|_next/image|favicon.ico|robots.txt|install|uninstall).*)",
    },
  ],
};
