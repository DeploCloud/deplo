import { builder } from "../builder";
import {
  getMcpSettings,
  setMcpSettings,
  type McpSettings,
} from "@/lib/data/mcp-settings";
import {
  listMcpConnections,
  mintMcpConnection,
  type McpConnectionDTO,
} from "@/lib/data/mcp-clients";

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

export const McpConnectionRef = builder
  .objectRef<McpConnectionDTO>("McpConnection")
  .implement({
    description:
      "An AI client connected to this team over OAuth. It holds an ordinary " +
      "API token, minted when someone approved the consent screen — so `id` is " +
      "that token's id, and revoking it is `revokeToken`, which takes away the " +
      "active team's access and deletes the connection with the last team.",
    fields: (t) => ({
      id: t.exposeID("id"),
      clientName: t.exposeString("clientName"),
      clientUri: t.exposeString("clientUri", { nullable: true }),
      clientIcon: t.exposeString("clientIcon", { nullable: true }),
      redirectOrigin: t.exposeString("redirectOrigin", {
        nullable: true,
        description:
          "Where this client may be redirected back to. The one thing about " +
          "itself it cannot choose freely, unlike its name.",
      }),
      username: t.exposeString("username", { nullable: true }),
      teamId: t.exposeID("teamId"),
      teamName: t.exposeString("teamName"),
      teamNames: t.stringList({
        description:
          "Every team this connection was approved for. Revoking it removes " +
          "the team you are acting in, not the connection - the others keep " +
          "working until the last one lets go.",
        resolve: (c) => c.teams.map((x) => x.name),
      }),
      capabilities: t.exposeStringList("capabilities"),
      lastUsedAt: t.exposeString("lastUsedAt", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
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
  mcpConnections: t.field({
    type: [McpConnectionRef],
    authScopes: { capability: "manage_mcp" },
    description: "AI clients connected to this team over OAuth.",
    resolve: () => listMcpConnections(),
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
  authorizeMcpClient: t.boolean({
    authScopes: { capability: "manage_mcp" },
    description:
      "Approve an AI client: mint an API token with the chosen capabilities and " +
      "scope, and link it to the client. Also needs `manage_tokens`, and cannot " +
      "grant more than the approver holds. The OAuth handshake itself is then " +
      "finished by the browser posting to `/api/auth/oauth2/consent` — that " +
      "endpoint refuses a server-side call, so it cannot be done here. " +
      "`teamIds` names the teams the connection may work in — the team it is " +
      "created from is always included, and each one is gated in that team.",
    args: {
      clientId: t.arg.string({ required: true }),
      capabilities: t.arg.stringList({ required: false }),
      teamIds: t.arg.stringList({ required: false }),
      projectIds: t.arg.stringList({ required: false }),
      folderIds: t.arg.stringList({ required: false }),
      appIds: t.arg.stringList({ required: false }),
      expectedTeamId: t.arg.string({
        required: false,
        description:
          "The team the consent screen showed. Not a choice — the server takes " +
          "the team from the session — but a disagreement is refused rather " +
          "than connecting the client to a team nobody read.",
      }),
    },
    resolve: async (_p, a) => {
      await mintMcpConnection({
        clientId: a.clientId,
        capabilities: (a.capabilities ?? undefined) as
          | Parameters<typeof mintMcpConnection>[0]["capabilities"]
          | undefined,
        teamIds: a.teamIds ?? undefined,
        projectIds: a.projectIds ?? undefined,
        folderIds: a.folderIds ?? undefined,
        appIds: a.appIds ?? undefined,
        expectedTeamId: a.expectedTeamId ?? undefined,
      });
      return true;
    },
  }),
}));
