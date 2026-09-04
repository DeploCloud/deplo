import "server-only";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { DEPLO_VERSION } from "../version";
import { DOCS_BASE } from "../docs";
import { runWithIdentity } from "../auth/request-context";
import type { Capability } from "../types";
import type { GraphQLContext } from "../graphql/context";
import type { McpSettings } from "../data/mcp-settings";
import { MCP_TOOLS, type McpToolDef } from "./tools";
import { runGraphql } from "./execute";

/**
 * Builds the MCP server for ONE request. The authoritative refusal happens inside
 * `lib/data/*` when the tool runs, and a tool that slipped through the filter
 * would still be refused there.
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
   * Resolve the context for ANOTHER team this connection may act in. MUST THROW
   * for a team it may not.
   */
  forTeam: (team: string) => Promise<GraphQLContext>;
}

/**
 * The team a call works in. On every tool, always: a connection reaches every
 * team its owner may connect agents to, and the one thing an agent must never
 * be left guessing is how to get to another one.
 */
const TEAM_ARG = z
  .string()
  .optional()
  .describe(
    "Team id or slug, from list_teams. Omit for this connection's default team.",
  );

function visible(tool: McpToolDef, principal: McpPrincipal): boolean {
  if (tool.requires === null) return true;
  if (tool.requires === "instanceAdmin") return principal.instanceAdmin;
  return principal.capabilities.has(tool.requires);
}

/**
 * Slice the single top-level array in a result, so a fleet of 74 apps does not
 * arrive as one wall of JSON.
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

/**
 * Sent once at `initialize`. The tool table says what Deplo can DO; this says
 * what Deplo IS, so an agent uses Deplo's own words and knows where to read more.
 */
const instructions = `Deplo is a self-hosted deploy platform: it turns repositories, Docker images and Compose files into containers fronted by Traefik, on servers this instance manages.

Its vocabulary, which the tools use literally:
- App: the deployable unit. Never call it a service or a project.
- Project: a container of Environments (production, staging). Each Environment owns its own Apps and shared variables.
- Folder: a grouping of Apps with its own access grants.
- Server: a machine in the fleet. Servers are shared; everything else belongs to one team.

How to work here:
- Every call runs in ONE team. \`whoami\` names the default; \`list_teams\` names every team this connection can act in. To work in another team, pass its id or slug as the \`team\` argument of any tool - there is no "switch team" step, the argument IS the switch. \`find\` searches every team at once and says which team each hit is in.
- What you may do is exactly the token's Capabilities, clamped to what its owner holds in each team. A refusal is an answer, not something to retry another way.
- Secret variables are write-only: nothing reveals a secret's value, by design.

The user manual is at ${DOCS_BASE} - read it there when you need to explain how something works.`;

export function buildMcpServer(principal: McpPrincipal): McpServer {
  const server = new McpServer(
    { name: "deplo", version: DEPLO_VERSION },
    {
      capabilities: { tools: {} },
      instructions,
    },
  );

  for (const tool of MCP_TOOLS) {
    if (!visible(tool, principal)) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        // Every tool takes the team as an optional argument. Added centrally so
        // the rows stay a table of what Deplo can do, with nothing about
        // tenancy repeated in each of them.
        // Unknown keys are kept, not stripped, so the handler below can REFUSE
        // them by name. Advertising `additionalProperties: false` instead would
        // make a client's own validator answer, and never in Deplo's words.
        inputSchema: tool.input.extend({ team: TEAM_ARG }).passthrough(),
        // `readOnlyHint` and `idempotentHint` already default to false, so
        // spelling them out bought nothing and cost a line on every tool. The
        // other two default to TRUE and have to stay explicit.
        annotations: {
          ...(tool.readOnly ? { readOnlyHint: true } : {}),
          ...(tool.idempotent ? { idempotentHint: true } : {}),
          destructiveHint: tool.destructive ?? false,
          // Every tool acts on this Deplo instance and nothing else.
          openWorldHint: false,
        },
      },
      async (args) => {
        // No confirmation step, deliberately. What an agent may do is the token's
        // Capabilities and nothing on top: a second gate here would be a second permission
        // system, and it could only ever drift from the first.
        try {
          // An argument this tool does not take is a REFUSAL that names it. Dropped
          // silently (zod's default), `container` instead of `service` reaches the
          // resolver as "no container was given", and the model reads Deplo's "pick
          // one" as its own mistake and tries another spelling. `_`-prefixed keys
          // are protocol metadata some clients add, never the model's doing.
          const accepted = new Set([...Object.keys(tool.input.shape), "team"]);
          const unknown = Object.keys(args).filter(
            (k) => !accepted.has(k) && !k.startsWith("_"),
          );
          if (unknown.length)
            return failure(
              accepted.size === 1
                ? `${tool.name} takes no argument "${unknown[0]}", and no arguments at all.`
                : `${tool.name} takes no argument "${unknown[0]}". It takes: ${[...accepted].join(", ")}.`,
            );

          // `team` is Deplo's, not the tool's: taken out before the arguments
          // become GraphQL variables, and resolved into a whole principal
          // rather than passed down as a value some resolver might trust.
          const { team, ...rest } = args as Record<string, unknown> & {
            team?: string;
          };
          const ctx = team ? await principal.forTeam(team) : principal.gql;

          // The two tools that bypass GraphQL have to enter the identity themselves:
          // `runGraphql` does it for every other tool, and `handler.fetch` runs OUTSIDE the
          // scope the route opened.
          if (tool.run) {
            const go = () => tool.run!(rest, ctx);
            return text(
              await (ctx.identity ? runWithIdentity(ctx.identity, go) : go()),
            );
          }

          const variables = tool.variables
            ? tool.variables(rest)
            : (rest as Record<string, unknown>);
          const { data, error } = await runGraphql(tool.query, variables, ctx);
          // Surfaced verbatim: Deplo's messages are written to be read by a person ("This
          // token is limited to specific projects and can't access …"), and that is exactly
          // the sentence the model needs in order to do something else instead.
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
