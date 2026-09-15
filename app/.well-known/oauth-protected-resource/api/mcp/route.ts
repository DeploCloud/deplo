import {
  oauthPreflight,
  protectedResourceResponse,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return protectedResourceResponse();
}

export function OPTIONS() {
  return oauthPreflight();
}
