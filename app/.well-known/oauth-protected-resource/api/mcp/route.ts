import {
  oauthPreflight,
  protectedResourceResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 9728, resource-suffixed form — the path a client derives from the resource
 * URL `<base>/api/mcp`, and the one `/api/mcp`'s `WWW-Authenticate` points at.
 * Same document as the bare path above it.
 */
export function GET() {
  return protectedResourceResponse();
}

export function OPTIONS() {
  return oauthPreflight();
}
