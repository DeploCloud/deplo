import "server-only";

import {
  McpServer,
  acceptedContent,
  inputRequired,
  CLIENT_CAPABILITIES_META_KEY,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { DEPLO_VERSION } from "../version";
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
}

function visible(tool: McpToolDef, principal: McpPrincipal): boolean {
  if (tool.requires === null) return true;
  if (tool.requires === "instanceAdmin") return principal.instanceAdmin;
  return principal.capabilities.has(tool.requires);
}

/**
 * The elicitation a destructive tool sends before it does anything. A zod schema
 * rather than raw JSON Schema: the SDK converts it to the restricted wire shape,
 * and one boolean is the most a confirmation should ever ask for.
 */
const CONFIRM_SCHEMA = z.object({
  confirm: z
    .boolean()
    .describe("Tick to let the assistant perform this action."),
});

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
 * Whether this client can actually show a confirmation prompt.
 *
 * A server may only ask for input the client declared it can provide — asking
 * anyway is a `-32021` protocol error, which reaches the model as an opaque
 * failure rather than as something it can act on. So we ask the envelope first
 * and, when the answer is no, refuse the action in a sentence that says what to
 * change. Refusing is the only honest branch: running the destructive tool
 * anyway would quietly ignore the team's policy, which is the one thing the
 * switch exists to prevent.
 */
function canElicit(ctx: { mcpReq?: { envelope?: Record<string, unknown> } }) {
  const caps = ctx.mcpReq?.envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: { form?: unknown } }
    | undefined;
  return Boolean(caps?.elicitation?.form);
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
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly ?? false,
          destructiveHint: tool.destructive ?? false,
          idempotentHint: tool.idempotent ?? false,
          // Every tool acts on this deplo instance and nothing else.
          openWorldHint: false,
        },
      },
      async (args, ctx) => {
        // The human in the loop, when the team asked for one. `acceptedContent`
        // returns undefined for a missing, declined or cancelled elicitation —
        // all three mean "do not proceed", so one check covers them.
        if (tool.destructive && principal.settings.confirmDestructive) {
          const answer = acceptedContent<{ confirm?: boolean }>(
            ctx.mcpReq?.inputResponses,
            "confirm",
          );
          if (!answer?.confirm) {
            if (answer !== undefined)
              return failure("Cancelled: nobody confirmed this action.");
            if (!canElicit(ctx))
              return failure(
                `${tool.name} needs a human to confirm it, but this MCP client can't show a confirmation prompt. ` +
                  "Either use a client that supports elicitation, or turn off \"Ask before destructive actions\" in Settings → MCP Server.",
              );
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: tool.confirm!(args),
                  requestedSchema: CONFIRM_SCHEMA,
                }),
              },
            });
          }
        }

        try {
          if (tool.run) return text(await tool.run(args));

          const variables = tool.variables
            ? tool.variables(args)
            : (args as Record<string, unknown>);
          const { data, error } = await runGraphql(
            tool.query,
            variables,
            principal.gql,
          );
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
