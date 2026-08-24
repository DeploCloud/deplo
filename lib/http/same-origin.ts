import type { NextRequest } from "next/server";

/**
 * Belt-and-braces CSRF check for a cookie-authenticated route: refuse a request
 * whose `Origin` points at another site. Same-origin browser requests either omit
 * `Origin` (a top-level GET / EventSource) or send one matching the request host;
 * a genuine cross-site form/fetch carries a foreign one. `SameSite=Lax` on the
 * session cookie is the load-bearing defense — this mirrors the GraphQL route's
 * explicit assertion so a shared cookie can't be replayed cross-origin against
 * these REST routes. Absent `Origin` is allowed (Lax covers it);
 * present-and-mismatched is refused. Shared so every cookie-auth route checks it
 * the same way.
 */
export function isCrossSite(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true;
  }
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    "";
  return originHost !== host;
}

/** The 403 a cross-site request gets. */
export function crossSiteRefused(): Response {
  return Response.json(
    { error: "Cross-site request refused" },
    { status: 403 },
  );
}
