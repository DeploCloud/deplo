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

/**
 * The discovery documents, served from the SITE ROOT. Better Auth mounts its own
 * copies under `/api/auth/.well-known/…` because that is its base path.
 */

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "cache-control": "no-store" },
  });
}

/** A CORS preflight. Discovery can start in a browser. */
export function oauthPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/** RFC 9728. Served at both the bare path and the resource-suffixed one. */
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

/** RFC 8414 / OpenID discovery, both delegated to the plugin's own builders. */
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
