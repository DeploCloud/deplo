import { createMcpHandler } from "@modelcontextprotocol/server";
import { TEAM_HEADER } from "@/lib/team-path";
import { authenticateToken, stampMcpUse } from "@/lib/data/tokens/authenticate";
import { runWithIdentity } from "@/lib/auth/request-context";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getActiveTeamId, reachableCapabilities } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { listMcpTeams } from "@/lib/data/mcp-clients";
import type { GraphQLContext } from "@/lib/graphql/context";
import { rateLimit } from "@/lib/security";
import {
  OAUTH_CORS_HEADERS,
  resourceMetadataUrl,
} from "@/lib/auth/oauth-metadata";
import { buildMcpServer, type McpPrincipal } from "@/lib/mcp/server";

// No MCP-specific credential, ever: the one way to take this access away is revoking the API token.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Keyed on the token, not the IP: one token is one budget, two teams behind one NAT are two.
const RATE = { limit: 120, windowMs: 60_000 };

const FAILED_AUTH_RATE = { limit: 60, windowMs: 60_000 };

function callerAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

// The SDK runs the factory once per request, so the tool list can be filtered to this token.
const handler = createMcpHandler((ctx) =>
  buildMcpServer(ctx.authInfo!.extra!.principal as McpPrincipal),
);

// RFC 6750 challenge carrying RFC 9728 discovery; names no team, user or token - it must not be an oracle.
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

// Runs on every unauthenticated answer, so the endpoint costs an attacker something before a token is resolved.
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

type GrantedTeam = { id: string; slug: string; name: string };

function refusalFor(
  team: string,
  known: Awaited<ReturnType<typeof listMcpTeams>>,
): string | null {
  const t = known.find((k) => k.id === team || k.slug === team);
  if (!t)
    return `This connection has no access to the team "${team}". Run list_teams to see the teams it can act in.`;
  if (!t.mcpEnabled)
    return `The team "${t.name}" has turned off MCP access. An admin can switch it back on under Settings → MCP Server.`;
  if (!t.canConnect)
    return `You may not connect AI agents to the team "${t.name}". A team admin can grant the "Connect AI agents" permission.`;
  return null;
}

async function contextForTeam(
  raw: string,
  teams: GrantedTeam[],
  team: string,
): Promise<GraphQLContext> {
  const match = teams.find((t) => t.id === team || t.slug === team);
  const refusal = new Error(
    `This connection has no access to the team "${team}". Run list_teams to see the teams it can act in.`,
  );
  if (!match) throw refusal;

  const identity = await authenticateToken(raw, match.id);
  // The header's fallback lands the token elsewhere; an ARGUMENT naming a team is strict, never swapped.
  if (!identity || identity.teamId !== match.id) throw refusal;

  return runWithIdentity(identity, async () => {
    // Re-read: the door checked the INITIAL team, so a `team` argument must not keep
    // operating where MCP was turned off since.
    const why = refusalFor(match.id, await listMcpTeams());
    if (why) throw new Error(why);
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
  // Case-insensitive: matching `Bearer ` exactly was a real bug on the deploy hook.
  const raw = /^bearer /i.test(header) ? header.slice(7).trim() : "";
  if (!raw)
    return refuse(
      request,
      "Authenticate first. A web AI client should follow the OAuth challenge on this response; a terminal agent sends a Deplo API token as `Authorization: Bearer deplo_…`, created under Settings → API tokens.",
    );

  const hint = request.headers.get(TEAM_HEADER);
  let first;
  try {
    first = await authenticateToken(raw, hint);
  } catch (e) {
    // An unmet two-factor policy THROWS rather than returning null.
    return refuse(request, e instanceof Error ? e.message : "Not authorized");
  }
  if (!first) return refuse(request, "That API token is not valid.");
  const identity = first;

  type Prepared =
    | { blocked: string }
    | { limited: Awaited<ReturnType<typeof rateLimit>> }
    | { principal: McpPrincipal };
  let prepared: Prepared;
  try {
    prepared = await runWithIdentity(identity, async (): Promise<Prepared> => {
      let active = identity;
      // `canConnect` is the owner's own `manage_mcp` capability, `mcpEnabled` the team's switch.
      const known = await listMcpTeams();
      const usable = known.filter((t) => t.mcpEnabled && t.canConnect);
      let why = refusalFor(active.teamId, known);
      // Only when no team was asked for: a named team is never swapped.
      if (why && !hint && usable.length > 0) {
        const moved = await authenticateToken(raw, usable[0].id);
        if (moved) {
          active = moved;
          why = null;
        }
      }
      if (why)
        return {
          blocked: usable.length
            ? `${why} This connection can act in: ${usable.map((t) => t.slug).join(", ")}.`
            : why,
        };

      const limited = await rateLimit(`mcp:${active.token!.id}`, RATE);
      if (!limited.ok) return { limited };

      // Every team the credential can NAME, not only the usable ones: an off-limits team must hear why.
      const teams = known.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
      }));
      const resolved = active;
      return runWithIdentity(resolved, async () => {
        const [viewer, teamId, capabilities, settings] = await Promise.all([
          getCurrentUser(),
          getActiveTeamId(),
          reachableCapabilities(),
          getMcpSettings(),
        ]);
        const principal: McpPrincipal = {
          gql: {
            viewer,
            teamId,
            capabilities,
            via: "token",
            identity: resolved,
          },
          settings,
          capabilities: new Set(capabilities),
          // Opt-in per token, never inherited from an admin creator: the token's flag, not the person's.
          instanceAdmin: resolved.token?.instanceAdmin === true,
          forTeam: (team) => contextForTeam(raw, teams, team),
        };
        return { principal };
      });
    });
  } catch (e) {
    return unauthorized(e instanceof Error ? e.message : "Not authorized");
  }

  if ("blocked" in prepared)
    return Response.json(
      { error: prepared.blocked },
      { status: 403, headers: OAUTH_CORS_HEADERS },
    );
  if ("limited" in prepared)
    return Response.json(
      { error: "Too many requests." },
      {
        status: 429,
        headers: {
          ...OAUTH_CORS_HEADERS,
          "retry-after": String(prepared.limited.retryAfterSec ?? 60),
        },
      },
    );

  // Past every gate, so the stamp means the token is genuinely driving an agent.
  stampMcpUse(identity.token!.id);

  return handler.fetch(request, {
    authInfo: {
      token: raw,
      clientId: identity.token!.id,
      scopes: [],
      // The SDK passes `extra` straight through to the factory uninspected: the seam for the principal.
      extra: { principal: prepared.principal },
    },
  });
}

// GET answers a browser or a 2025 GET-stream client with a sentence, not a blank failure.
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

// OPTIONS: browsers preflight before sending `Authorization`; bearer-only, so no `Allow-Credentials`.
export function OPTIONS() {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
