import "server-only";

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import { DEPLO_VERSION } from "../version";
import { DOCS_BASE } from "../docs";
import { runWithIdentity } from "../auth/request-context";
import type { Capability } from "../types/identity";
import type { GraphQLContext } from "../graphql/context";
import type { McpSettings } from "../data/mcp-settings";
import { MCP_TOOLS } from "./tools/catalog";
import type { McpToolDef } from "./tools/tool-def";
import { runGraphql } from "./execute";
import { safeMessage } from "../graphql/mask-error";

// The authoritative refusal is in `lib/data/*`: a tool that slips this filter is still refused there.

export interface McpPrincipal {
  gql: GraphQLContext;
  settings: McpSettings;
  capabilities: Set<Capability>;
  // Carried by the TOKEN, never inherited from the person.
  instanceAdmin: boolean;
  // MUST THROW for a team this connection may not act in.
  forTeam: (team: string) => Promise<GraphQLContext>;
}

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
- A compose app's YAML is the user's to edit, in full: \`get_app\` returns it, \`update_app_compose\` replaces it. Only the editor's own checks apply (host access needs an admin grant; Deplo's own names are reserved), nothing else is off limits.

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
        // passthrough: unknown keys must reach the handler to be refused by name, not by a client's own validator.
        inputSchema: tool.input.extend({ team: TEAM_ARG }).passthrough(),
        // `destructiveHint` and `openWorldHint` default to TRUE upstream, so they have to stay explicit.
        annotations: {
          ...(tool.readOnly ? { readOnlyHint: true } : {}),
          ...(tool.idempotent ? { idempotentHint: true } : {}),
          destructiveHint: tool.destructive ?? false,
          openWorldHint: false,
        },
      },
      async (args) => {
        // No confirmation step: a gate here would be a second permission system beside the token's Capabilities.
        try {
          // zod drops an unknown key silently, so `container` for `service` read back as "no container was given";
          // `_`-prefixed keys are a client's protocol metadata, never the model's doing.
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

          // `team` is taken out BEFORE the arguments become GraphQL variables, and resolved into a principal.
          const { team, ...rest } = args as Record<string, unknown> & {
            team?: string;
          };
          const ctx = team ? await principal.forTeam(team) : principal.gql;

          // `handler.fetch` runs OUTSIDE the scope the route opened, and a tool bypassing GraphQL misses `runGraphql`'s.
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
          if (error) return failure(error);
          // The cast is safe: a paginated tool's own zod schema declares limit/offset (pinned by tools.test.ts).
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
          return failure(safeMessage(e));
        }
      },
    );
  }

  return server;
}
