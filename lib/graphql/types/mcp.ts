import { builder } from "../builder";
import {
  getMcpSettings,
  setMcpSettings,
  type McpSettings,
} from "@/lib/data/mcp-settings";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const McpSettingsRef = builder
  .objectRef<McpSettings>("McpSettings")
  .implement({
    description:
      "The active team's MCP policy: whether AI agents may drive it at all. " +
      "What an agent may DO is decided by its API token's capabilities, and " +
      "by nothing here.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
    }),
  });

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  mcpSettings: t.field({
    type: McpSettingsRef,
    authScopes: { capability: "manage_mcp" },
    description: "The active team's MCP policy.",
    resolve: () => getMcpSettings(),
  }),
}));

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

builder.mutationFields((t) => ({
  setMcpSettings: t.field({
    type: McpSettingsRef,
    authScopes: { capability: "manage_mcp" },
    description: "Turn MCP access on or off for this team.",
    args: {
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: (_p, a) => setMcpSettings({ enabled: a.enabled }),
  }),
}));
