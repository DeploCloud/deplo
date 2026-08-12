import {
  oauthPreflight,
  openIdConfigResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** OpenID discovery. Some clients fall back to it when RFC 8414 404s. */
export function GET(request: Request) {
  return openIdConfigResponse(request);
}

export function OPTIONS() {
  return oauthPreflight();
}
