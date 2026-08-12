import { publicBaseUrl } from "@/lib/public-url";

/**
 * The OAuth discovery surface, written down ONCE.
 *
 * Three places have to agree on these strings: the `WWW-Authenticate` challenge
 * `/api/mcp` sends on a 401, the route that serves the document that challenge
 * points at, and the `validAudiences` the token endpoint checks a client's
 * `resource` parameter against. When they disagree the failure is silent — a
 * client discovers an address that 404s, or every token exchange answers
 * "requested resource invalid" while the rest of the instance looks healthy.
 *
 * RFC 9728 puts protected-resource metadata at the SITE ROOT, with the resource's
 * own path appended (`/.well-known/oauth-protected-resource/api/mcp`), not under
 * the authorization server's base path. Better Auth serves its own copies under
 * `/api/auth/…`, which no MCP client probes; the routes under `app/.well-known/`
 * are the ones that count.
 */

/** The MCP endpoint's path. The OAuth *resource* is this, absolute. */
export const MCP_RESOURCE_PATH = "/api/mcp";

/**
 * Prefixes on the issued OAuth credentials.
 *
 * They must NOT begin with `deplo_`: `authenticateToken` branches on that exact
 * literal to decide which lookup to run, and two credential families answering
 * to one prefix is how a refresh token ends up being tried as an API token. The
 * prefix is stripped by the plugin before hashing, so it is never stored.
 */
export const OAUTH_ACCESS_TOKEN_PREFIX = "dplo_at_";
export const OAUTH_REFRESH_TOKEN_PREFIX = "dplo_rt_";
export const OAUTH_CLIENT_SECRET_PREFIX = "dplo_cs_";

/** RFC 9728's well-known prefix. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** The absolute resource identifier, or null when no public address is set. */
export function mcpResource(): string | null {
  const base = publicBaseUrl();
  return base ? `${base}${MCP_RESOURCE_PATH}` : null;
}

/**
 * The URL a `WWW-Authenticate` challenge points at — the path-suffixed form MCP
 * clients derive from the resource itself.
 */
export function resourceMetadataUrl(): string | null {
  const base = publicBaseUrl();
  return base ? `${base}${PROTECTED_RESOURCE_PATH}${MCP_RESOURCE_PATH}` : null;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_name: string;
  resource_documentation: string;
}

/**
 * The RFC 9728 document. Null when the instance has no public address: OAuth
 * cannot work without one, and a document naming a placeholder host sends a
 * client somewhere real and wrong.
 */
export function protectedResourceMetadata(): ProtectedResourceMetadata | null {
  const base = publicBaseUrl();
  if (!base) return null;
  return {
    resource: `${base}${MCP_RESOURCE_PATH}`,
    authorization_servers: [base],
    // The same four the authorization server advertises, so a client comparing
    // the two documents does not conclude it may not ask for one of them. They
    // decide nothing here: what an agent may do is its token's Capabilities.
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "deplo MCP server",
    resource_documentation: `${base}/settings/mcp`,
  };
}

/**
 * Headers every discovery document and the MCP endpoint itself answer with.
 *
 * `*` with no `Allow-Credentials`, deliberately: these endpoints are bearer-only
 * and have no cookie path, so reflecting an origin would buy nothing and open a
 * door. `expose-headers` is what lets a browser-based client read the challenge
 * and start discovery at all — without it the header is invisible to `fetch`.
 */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-protocol-version, x-deplo-team",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};
