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
      "The active team's MCP policy: whether AI agents may drive it, and " +
      "whether they must ask a human before a destructive action.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
      confirmDestructive: t.exposeBoolean("confirmDestructive"),
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
    description:
      "Turn MCP access on or off for this team, and choose whether destructive " +
      "tools must be confirmed by a human first. Omitted fields are unchanged.",
    args: {
      enabled: t.arg.boolean({ required: false }),
      confirmDestructive: t.arg.boolean({ required: false }),
    },
    resolve: (_p, a) =>
      setMcpSettings({
        enabled: a.enabled ?? undefined,
        confirmDestructive: a.confirmDestructive ?? undefined,
      }),
  }),
}));
