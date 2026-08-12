import {
  authServerMetadataResponse,
  oauthPreflight,
} from "@/lib/auth/oauth-well-known";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * RFC 8414 with the issuer's path inserted.
 *
 * deplo's issuer is `https://<host>/api/auth`, because that is Better Auth's
 * base path, so §3.1 puts its metadata here — the well-known segment first,
 * then the issuer's path — and NOT at `<issuer>/.well-known/…`. A client that
 * followed `authorization_servers` from the protected-resource document looks
 * exactly here; the copy at the root is for the ones that guess.
 */
export function GET(request: Request) {
  return authServerMetadataResponse(request);
}

export function OPTIONS() {
  return oauthPreflight();
}
