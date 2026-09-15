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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

const handler = createMcpHandler((ctx) =>
  buildMcpServer(ctx.authInfo!.extra!.principal as McpPrincipal),
);

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
  if (!identity || identity.teamId !== match.id) throw refusal;

  return runWithIdentity(identity, async () => {
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
      const known = await listMcpTeams();
      const usable = known.filter((t) => t.mcpEnabled && t.canConnect);
      let why = refusalFor(active.teamId, known);
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

  stampMcpUse(identity.token!.id);

  return handler.fetch(request, {
    authInfo: {
      token: raw,
      clientId: identity.token!.id,
      scopes: [],
      extra: { principal: prepared.principal },
    },
  });
}

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

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}
