import "server-only";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { DEPLO_VERSION } from "../version";
import { runWithIdentity } from "../auth/request-context";
import type { Capability } from "../types";
import type { GraphQLContext } from "../graphql/context";
import type { McpSettings } from "../data/mcp-settings";
import { MCP_TOOLS, type McpToolDef } from "./tools";
import { runGraphql } from "./execute";

/**
 * Builds the MCP server for ONE request.
 *
 * Per-request is the SDK's own model under the 2026-07-28 revision (the protocol
 * is stateless: no session, no handshake, nothing to keep between calls), and it
 * is also what lets `tools/list` be filtered to the tools this particular token
 * can actually call. A token minted from the "MCP & AI agents" preset sees 34 of
 * the 76, rather than 42 it would only fail on — which is both a kindness to the
 * model's context window and the honest answer to "what can I do here?".
 *
 * The filter is COSMETIC, exactly like `hasCapability` in the dashboard. The
 * authoritative refusal happens inside `lib/data/*` when the tool runs, and a
 * tool that slipped through the filter would still be refused there.
 */

export interface McpPrincipal {
  /** The GraphQL context built from this request's bearer token. */
  gql: GraphQLContext;
  /** The active team's MCP policy. */
  settings: McpSettings;
  /** The token's effective capabilities, for filtering `tools/list`. */
  capabilities: Set<Capability>;
  /** Whether this TOKEN carries instance-admin (never inherited from the person). */
  instanceAdmin: boolean;
  /**
   * Resolve the context for ANOTHER team this connection was granted.
   *
   * The team is an argument of the call, never a remembered setting: the
   * protocol is stateless, so there is no session to hold an "active team"
   * between requests and nothing for a `switch_team` tool to switch. Declaring
   * it per call is the shape that fits — and it means the connection has to
   * have been granted that team at consent, which is the only place authority
   * is handed out.
   *
   * MUST THROW for a team that was not granted. Falling back to another team is
   * how an agent once created an app somewhere nobody chose, and with several
   * teams in reach that mistake stops being visible at all.
   */
  forTeam: (team: string) => Promise<GraphQLContext>;
}

/**
 * The team a call works in, when the connection was granted more than one.
 *
 * Optional on purpose: a connection granted one team — the common case — never
 * needs it, and a model that omits it gets the team the connection belongs to.
 */
const TEAM_ARG = z
  .string()
  .optional()
  .describe(
    "Which team to work in. Only teams this connection was granted; see list_teams. Omit for the connection's own team.",
  );

function visible(tool: McpToolDef, principal: McpPrincipal): boolean {
  if (tool.requires === null) return true;
  if (tool.requires === "instanceAdmin") return principal.instanceAdmin;
  return principal.capabilities.has(tool.requires);
}

/**
 * Slice the single top-level array in a result, so a fleet of 74 apps does not
 * arrive as one wall of JSON. Reports the true total, because a model that
 * cannot tell "these are all of them" from "these are the first fifty" will
 * confidently tell its user the wrong thing.
 */
function paginate(
  data: unknown,
  limit: number | undefined,
  offset: number | undefined,
): unknown {
  if (!data || typeof data !== "object") return data;
  const entries = Object.entries(data as Record<string, unknown>);
  const target = entries.find(([, v]) => Array.isArray(v));
  if (!target) return data;
  const [key, list] = target as [string, unknown[]];
  const from = offset ?? 0;
  const size = limit ?? 50;
  const page = list.slice(from, from + size);
  return {
    ...(data as Record<string, unknown>),
    [key]: page,
    total: list.length,
    offset: from,
    hasMore: from + page.length < list.length,
  };
}

/**
 * Hard ceiling on one tool result, in characters.
 *
 * Paging covers the list tools, but not the one that reliably blows up:
 * `get_deployment` returns a whole build log, which for a failed Docker build is
 * routinely tens of thousands of lines. Something has to be the last line of
 * defence for the caller's context window, and a cap that keeps the END of the
 * output is the right shape — the tail is where the error is.
 */
const MAX_RESULT_CHARS = 60_000;

function text(value: unknown) {
  let body = JSON.stringify(value, null, 2) ?? "null";
  if (body.length > MAX_RESULT_CHARS)
    body =
      `[truncated: ${body.length} characters, showing the last ${MAX_RESULT_CHARS}]\n` +
      body.slice(-MAX_RESULT_CHARS);
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function buildMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer(
    { name: "deplo", version: DEPLO_VERSION },
    { capabilities: { tools: {} } },
  );

  for (const tool of MCP_TOOLS) {
    if (!visible(tool, principal)) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Every tool takes the team as an optional argument. Added centrally so
        // the 78 rows stay a table of what deplo can do, with nothing about
        // tenancy repeated in each of them.
        inputSchema: tool.input.extend({ team: TEAM_ARG }),
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly ?? false,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? false,
          // Every tool acts on this deplo instance and nothing else.
          openWorldHint: false,
        },
      },
      async (args) => {
        // No confirmation step, deliberately. What an agent may do is the
        // token's Capabilities and nothing on top: a second gate here would be
        // a second permission system, and it could only ever drift from the
        // first. `destructiveHint` above is how the caller's own client knows
        // to ask - which is the only place a prompt can actually be rendered.
        try {
          // `team` is deplo's, not the tool's: taken out before the arguments
          // become GraphQL variables, and resolved into a whole principal
          // rather than passed down as a value some resolver might trust.
          const { team, ...rest } = args as Record<string, unknown> & {
            team?: string;
          };
          const ctx = team ? await principal.forTeam(team) : principal.gql;

          // The two tools that bypass GraphQL have to enter the identity
          // themselves: `runGraphql` does it for every other tool, and
          // `handler.fetch` runs OUTSIDE the scope the route opened. Without
          // this they resolve no team at all — `requireActiveTeamId` finds
          // neither an identity nor a cookie — so every log read answered "No
          // active team", and the `team` argument above was ignored for them.
          if (tool.run) {
            const go = () => tool.run!(rest);
            return text(
              await (ctx.identity ? runWithIdentity(ctx.identity, go) : go()),
            );
          }

          const variables = tool.variables
            ? tool.variables(rest)
            : (rest as Record<string, unknown>);
          const { data, error } = await runGraphql(tool.query, variables, ctx);
          // Surfaced verbatim: deplo's messages are written to be read by a
          // person ("This token is limited to specific projects and can't
          // access …"), and that is exactly the sentence the model needs in
          // order to do something else instead.
          if (error) return failure(error);
          // Validated by the tool's own zod schema before this runs (the test
          // pins that a paginated tool declares both), so the cast asserts what
          // the SDK already checked.
          return text(
            tool.paginate
              ? paginate(
                  data,
                  args.limit as number | undefined,
                  args.offset as number | undefined,
                )
              : data,
          );
        } catch (e) {
          return failure(e instanceof Error ? e.message : String(e));
        }
      },
    );
  }

  return server;
}
