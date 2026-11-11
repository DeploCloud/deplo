import { getCurrentUser } from "../auth/current-user";
import { runWithIdentity, type RequestIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";
import { getActiveTeamId, reachableCapabilities } from "../membership";
import { runGraphql } from "./execute";
import { MCP_TOOLS } from "./tools/catalog";

/** Runs one MCP tool as this identity, through the schema and its field gates like /api/mcp does. */
export async function runTool(
  identity: RequestIdentity,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = MCP_TOOLS.find((t) => t.name === name)!;
  const ctx = await runWithIdentity(
    identity,
    async (): Promise<GraphQLContext> => ({
      viewer: await getCurrentUser(),
      teamId: await getActiveTeamId(),
      capabilities: await reachableCapabilities(),
      via: "token",
      identity,
    }),
  );
  return runGraphql(tool.query, tool.variables?.(args as never) ?? args, ctx);
}
