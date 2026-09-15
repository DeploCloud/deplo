import "server-only";

import {
  oauthProviderAuthServerMetadata,
  oauthProviderOpenIdConfigMetadata,
} from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth/better-auth";
import {
  OAUTH_CORS_HEADERS,
  protectedResourceMetadata,
} from "@/lib/auth/oauth-metadata";

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "cache-control": "no-store" },
  });
}

export function oauthPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

export function protectedResourceResponse(): Response {
  const doc = protectedResourceMetadata();
  if (!doc)
    return json(
      {
        error: "server_error",
        error_description:
          "This Deplo instance has no public address set, so OAuth cannot work. Set one under Settings → General.",
      },
      503,
    );
  return json(doc);
}

export async function authServerMetadataResponse(
  request: Request,
): Promise<Response> {
  const auth = getAuth();
  if (!auth) return json({ error: "server_error" }, 503);
  return oauthProviderAuthServerMetadata(auth, {
    headers: OAUTH_CORS_HEADERS,
  })(request);
}

export async function openIdConfigResponse(
  request: Request,
): Promise<Response> {
  const auth = getAuth();
  if (!auth) return json({ error: "server_error" }, 503);
  return oauthProviderOpenIdConfigMetadata(auth, {
    headers: OAUTH_CORS_HEADERS,
  })(request);
}
