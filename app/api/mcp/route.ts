import { createMcpHandler } from "@modelcontextprotocol/server";
import { authenticateToken } from "@/lib/data/tokens";
import { runWithIdentity } from "@/lib/auth/request-context";
import { getCurrentUser } from "@/lib/auth";
import { getActiveTeamId, reachableCapabilities } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { rateLimit } from "@/lib/security";
import {
  OAUTH_CORS_HEADERS,
  resourceMetadataUrl,
} from "@/lib/auth/oauth-metadata";
import { buildMcpServer, type McpPrincipal } from "@/lib/mcp/server";

/**
 * The deplo MCP server — protocol revision **2026-07-28**.
 *
 *   POST /api/mcp   Authorization: Bearer deplo_…
 *                   X-Deplo-Team: <team id or slug>   (optional)
 *
 * An AI agent reaches deplo's features here, as an ordinary API token: the same
 * principal, the same Capabilities, the same audit trail as every other external
 * client (ADR-0015). There is no MCP-specific credential and there must never be
 * one — "how do I take this access away" has to keep having one answer, and that
 * answer is "revoke the token".
 *
 * The protocol is stateless at 2026-07-28: no session, no `initialize`
 * handshake, no `Mcp-Session-Id`. Every request carries its own protocol version
 * and capabilities, so this route authenticates, checks the team's switch, and
 * hands one self-contained request to the SDK. Nothing survives between calls,
 * which is also why a connection is pinned to ONE team by the header above: with
 * no session there is nothing for a "switch team" tool to switch.
 *
 * Team selection, the JSON body and the bearer scheme are all deliberately the
 * same contract `/api/graphql` uses. An agent and a CI script are the same kind
 * of client; only the framing differs.
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
 * The factory runs once per request (the SDK's model under a stateless
 * protocol), so the tool list can be filtered to what this token may call.
 */
const handler = createMcpHandler((ctx) =>
  buildMcpServer(ctx.authInfo!.extra!.principal as McpPrincipal),
);

/**
 * The RFC 6750 challenge, carrying RFC 9728 discovery.
 *
 * `resource_metadata` is how a web AI client that has never seen deplo finds its
 * way in: it reads that document, learns the authorization server, registers
 * itself and sends the user here to consent. A terminal agent keeps ignoring the
 * header and sending a `deplo_` token, exactly as before.
 *
 * The message names both routes in, because a bare 401 leaves the operator
 * guessing which of the two they were supposed to use. It names no team, user or
 * token — a challenge must not be an oracle.
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

export async function POST(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  // Case-insensitive: matching `Bearer ` exactly was a real bug on the deploy
  // hook, and MCP clients spell it however their HTTP library does.
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  if (!raw)
    return unauthorized(
      "Authenticate first. A web AI client should follow the OAuth challenge on this response; a terminal agent sends a deplo API token as `Authorization: Bearer deplo_…`, created under Settings → API tokens.",
    );

  let identity;
  try {
    identity = await authenticateToken(raw, request.headers.get("x-deplo-team"));
  } catch (e) {
    // An unmet two-factor policy THROWS rather than returning null. Surfacing it
    // as the 401 body beats a 500 that tells the operator nothing.
    return unauthorized(e instanceof Error ? e.message : "Not authorized");
  }
  if (!identity) return unauthorized("That API token is not valid.");

  // Everything below resolves as the token's principal. Wrapped because the
  // membership reads inside can still refuse — the two-factor gate runs again in
  // `requireActiveTeamId`, and a policy that turns a request away should answer
  // in a sentence rather than as an unhandled 500.
  let prepared;
  try {
    prepared = await runWithIdentity(identity, async () => {
      const settings = await getMcpSettings();
      if (!settings.enabled) return { blocked: true as const };

      const limited = await rateLimit(`mcp:${identity.token!.id}`, RATE);
      if (!limited.ok) return { blocked: false as const, limited };

      const [viewer, teamId, capabilities] = await Promise.all([
        getCurrentUser(),
        getActiveTeamId(),
        reachableCapabilities(),
      ]);
      const principal: McpPrincipal = {
        gql: { viewer, teamId, capabilities, via: "token", identity },
        settings,
        capabilities: new Set(capabilities),
        // Instance-admin is opt-in per token and never inherited from an admin
        // creator, so this is the token's own flag, not the person's.
        instanceAdmin: identity.token?.instanceAdmin === true,
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

  return handler.fetch(request, {
    authInfo: {
      token: raw,
      clientId: identity.token!.id,
      scopes: [],
      // The SDK passes this straight through to the factory; it never inspects
      // it. This is the seam that carries deplo's principal into the tools.
      extra: { principal: prepared.principal },
    },
  });
}

/**
 * A browser hitting this URL, or a client configured for the 2025 GET stream,
 * gets a sentence instead of a blank failure — the same courtesy the deploy hook
 * pays. The 2026-07-28 transport has no GET endpoint at all: server-to-client
 * notifications ride `subscriptions/listen`, which is a POST.
 */
export async function GET() {
  return Response.json(
    {
      error: "Method not allowed",
      detail:
        "This is deplo's MCP endpoint. Paste this URL into a web AI client and sign in when asked, or point a terminal agent at it over POST with `Authorization: Bearer deplo_…`.",
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
