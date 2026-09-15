import { publicBaseUrl } from "@/lib/public-url";

export const MCP_RESOURCE_PATH = "/api/mcp";

export const OAUTH_ACCESS_TOKEN_PREFIX = "dplo_at_";

export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

export const AUTH_BASE_PATH = "/api/auth";

export function oauthIssuer(): string | null {
  const base = publicBaseUrl();
  return base ? `${base}${AUTH_BASE_PATH}` : null;
}

export function mcpResource(): string | null {
  const base = publicBaseUrl();
  return base ? `${base}${MCP_RESOURCE_PATH}` : null;
}

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

export function protectedResourceMetadata(): ProtectedResourceMetadata | null {
  const base = publicBaseUrl();
  if (!base) return null;
  return {
    resource: `${base}${MCP_RESOURCE_PATH}`,
    authorization_servers: [`${base}${AUTH_BASE_PATH}`],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_name: "Deplo MCP server",
    resource_documentation: `${base}/settings/mcp`,
  };
}

export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, mcp-protocol-version, x-deplo-team",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};
