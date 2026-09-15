"use client";

import { gqlAction } from "@/lib/graphql-client";
import type { AgentDef } from "../agents";

export const POLL_MS = 2000;
export const POLL_LIMIT = 150;

export async function probe(
  kind: AgentDef["kind"],
  tokenId: string | null,
  baseline: number,
): Promise<boolean> {
  if (kind === "token") {
    if (!tokenId) return false;
    const res = await gqlAction<{ mcpConnected: boolean }, boolean>(
      /* GraphQL */ `
        query McpConnected($tokenId: String!) {
          mcpConnected(tokenId: $tokenId)
        }
      `,
      { tokenId },
      (d) => d.mcpConnected,
    );
    return res.ok && res.data === true;
  }
  const res = await gqlAction<{ mcpAgentCount: number }, number>(
    /* GraphQL */ `
      query McpAgentCount {
        mcpAgentCount
      }
    `,
    {},
    (d) => d.mcpAgentCount,
  );
  return res.ok && typeof res.data === "number" && res.data > baseline;
}
