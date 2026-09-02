import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticateToken, stampMcpUse } from "@/lib/data/tokens";
import { runWithIdentity } from "@/lib/auth/request-context";
import { getCurrentUser } from "@/lib/auth";
import { getActiveTeamId, reachableCapabilities } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { listMyTeams } from "@/lib/data/teams";
import type { GraphQLContext } from "@/lib/graphql/context";
import { rateLimit } from "@/lib/security";
import {
  OAUTH_CORS_HEADERS,
  resourceMetadataUrl,
} from "@/lib/auth/oauth-metadata";
import { buildMcpServer, type McpPrincipal } from "@/lib/mcp/server";

/**
 * The Deplo MCP server - protocol revision **2026-07-28**. There is no
 * MCP-specific credential and there must never be one - "how do I take this access
 * away" has to keep having one answer, and that answer is "revoke the token".
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An agent in a loop is precisely the client that needs a limit, and the bearer
 * path has never had one. Keyed on the token, not the IP: a fleet of agents
 * sharing one token is one budget, and two teams behind one NAT are two.
 */
const RATE = { limit: 120, windowMs: 60_000 };

/**
 * The limit on requests that never authenticate. Keyed on the address, because a
 * caller that has not authenticated has no other name.
 */
const FAILED_AUTH_RATE = { limit: 60, windowMs: 60_000 };

function callerAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/**
 * The factory runs once per request (the SDK's model under a stateless
 * protocol), so the tool list can be filtered to what this token may call.
 */
const handler = createMcpHandler((ctx) =>
  buildMcpServer(ctx.authInfo!.extra!.principal as McpPrincipal),
);

/**
 * The RFC 6750 challenge, carrying RFC 9728 discovery. A terminal agent keeps
 * ignoring the header and sending a `deplo_` token, exactly as before. It names no
 * team, user or token - a challenge must not be an oracle.
 */
function unauthorized(message: string) {
  const metadata = resourceMetadataUrl();
  return Response.json(
    { error: message },
    {
      status: 401,
      headers: {
        ...OAUTH_CORS_HEADERS,
        "www-authenticate": metadata
          ? `Bearer realm="deplo", error="invalid_token", resource_metadata="${metadata}"`
          : 'Bearer realm="deplo", error="invalid_token"',
      },
    },
  );
}

/**
 * Count a request that failed to authenticate, and refuse once there are too
 * many from one address. Runs on every unauthenticated answer, so the endpoint
 * costs an attacker something even before a token is ever resolved.
 */
async function refuse(request: Request, message: string): Promise<Response> {
  const limited = await rateLimit(
    `mcp-auth:${callerAddress(request)}`,
    FAILED_AUTH_RATE,
  );
  if (!limited.ok)
    return Response.json(
      { error: "Too many failed attempts." },
      {
        status: 429,
        headers: {
          ...OAUTH_CORS_HEADERS,
          "retry-after": String(limited.retryAfterSec),
        },
      },
    );
  return unauthorized(message);
}

type GrantedTeam = { id: string; slug: string };

/**
 * The context for a team a tool named explicitly, or a refusal. `teams` is what
 * this connection may reach, resolved once per request by the caller.
 */
async function contextForTeam(
  raw: string,
  teams: GrantedTeam[],
  team: string,
): Promise<GraphQLContext> {
  const match = teams.find((t) => t.id === team || t.slug === team);
  const refusal = new Error(
    `This connection has no access to the team "${team}". Run whoami to see the teams it was granted.`,
  );
  if (!match) throw refusal;

  const identity = await authenticateToken(raw, match.id);
  if (!identity) throw refusal;

  return runWithIdentity(identity, async () => {
    // The per-team MCP kill switch (`teams.mcp_enabled`) is checked at the door
    // for the INITIAL team; re-check it here so a tool switching team via its
    // `team` argument can't keep operating in a team that turned MCP off.
    const settings = await getMcpSettings();
    if (!settings.enabled)
      throw new Error(`The team "${team}" has the MCP server turned off.`);
    const [viewer, teamId, capabilities] = await Promise.all([
      getCurrentUser(),
      getActiveTeamId(),
      reachableCapabilities(),
    ]);
    return { viewer, teamId, capabilities, via: "token" as const, identity };
  });
}

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  // Case-insensitive: matching `Bearer ` exactly was a real bug on the deploy
  // hook, and MCP clients spell it however their HTTP library does.
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  if (!raw)
    return refuse(
      request,
      "Authenticate first. A web AI client should follow the OAuth challenge on this response; a terminal agent sends a Deplo API token as `Authorization: Bearer deplo_…`, created under Settings → API tokens.",
    );

  let identity;
  try {
    identity = await authenticateToken(
      raw,
      request.headers.get("x-deplo-team"),
    );
  } catch (e) {
    // An unmet two-factor policy THROWS rather than returning null. Surfacing it
    // as the 401 body beats a 500 that tells the operator nothing.
    return refuse(request, e instanceof Error ? e.message : "Not authorized");
  }
  if (!identity) return refuse(request, "That API token is not valid.");

  // Everything below resolves as the token's principal.
  let prepared;
  try {
    prepared = await runWithIdentity(identity, async () => {
      const settings = await getMcpSettings();
      if (!settings.enabled) return { blocked: true as const };

      const limited = await rateLimit(`mcp:${identity.token!.id}`, RATE);
      if (!limited.ok) return { blocked: false as const, limited };

      const [viewer, teamId, capabilities, teams] = await Promise.all([
        getCurrentUser(),
        getActiveTeamId(),
        reachableCapabilities(),
        // Resolved up front so `tools/list` knows whether a `team` argument is
        // worth publishing at all, and so `forTeam` does not read it again.
        listMyTeams(),
      ]);
      const principal: McpPrincipal = {
        gql: { viewer, teamId, capabilities, via: "token", identity },
        settings,
        capabilities: new Set(capabilities),
        // Instance-admin is opt-in per token and never inherited from an admin
        // creator, so this is the token's own flag, not the person's.
        instanceAdmin: identity.token?.instanceAdmin === true,
        multiTeam: teams.length > 1,
        forTeam: (team) => contextForTeam(raw, teams, team),
      };
      return { blocked: false as const, principal };
    });
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Not authorized");
  }

  if (prepared.blocked)
    return Response.json(
      {
        error:
          "This team has turned off MCP access. An admin can switch it back on under Settings → MCP Server.",
      },
      { status: 403, headers: OAUTH_CORS_HEADERS },
    );
  if (!prepared.principal)
    return Response.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: {
          ...OAUTH_CORS_HEADERS,
          "retry-after": String(prepared.limited?.retryAfterSec ?? 60),
        },
      },
    );

  // Past every gate, so this request is genuinely being served: the token is driving
  // an agent right now.
  stampMcpUse(identity.token!.id);

  return handler.fetch(request, {
    authInfo: {
      token: raw,
      clientId: identity.token!.id,
      scopes: [],
      // The SDK passes this straight through to the factory; it never inspects
      // it. This is the seam that carries Deplo's principal into the tools.
      extra: { principal: prepared.principal },
    },
  });
}

/**
 * A browser hitting this URL, or a client configured for the 2025 GET stream, gets
 * a sentence instead of a blank failure - the same courtesy the deploy hook pays.
 */
export async function GET() {
  return Response.json(
    {
      error: "Method not allowed",
      detail:
        "This is Deplo's MCP endpoint. Paste this URL into a web AI client and sign in when asked, or point a terminal agent at it over POST with `Authorization: Bearer deplo_…`.",
      protocolVersion: "2026-07-28",
    },
    { status: 405, headers: { ...OAUTH_CORS_HEADERS, allow: "POST" } },
  );
}

/**
 * A browser-based MCP client preflights before it can send `Authorization` or
 * read the challenge off a 401. Same headers everywhere, and no
 * `Allow-Credentials`: this endpoint is bearer-only and has no cookie path.
 */
export function OPTIONS() {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
