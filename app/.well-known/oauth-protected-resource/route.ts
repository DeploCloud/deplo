import {
  oauthPreflight,
  protectedResourceResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RFC 9728, bare form. Public: a client discovers Deplo before it has a token. */
export function GET() {
  return protectedResourceResponse();
}

export function OPTIONS() {
  return oauthPreflight();
}
