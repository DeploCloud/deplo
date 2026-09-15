import type { NextRequest } from "next/server";

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

export function crossSiteRefused(): Response {
  return Response.json(
    { error: "Cross-site request refused" },
    { status: 403 },
  );
}
