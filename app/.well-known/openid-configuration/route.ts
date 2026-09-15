import {
  oauthPreflight,
  openIdConfigResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return openIdConfigResponse(request);
}

export function OPTIONS() {
  return oauthPreflight();
}
