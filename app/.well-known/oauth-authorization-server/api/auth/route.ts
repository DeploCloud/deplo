import {
  authServerMetadataResponse,
  oauthPreflight,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 8414 with the issuer's path inserted.
 */
export function GET(request: Request) {
  return authServerMetadataResponse(request);
}

export function OPTIONS() {
  return oauthPreflight();
}
