import { builder } from "../builder";
import {
  getMcpSettings,
  setMcpSettings,
  type McpSettings,
} from "@/lib/data/mcp-settings";
import {
  listMcpConnections,
  mcpTokenConnected,
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
      "An AI client that can act in this team over MCP. Either a web connector " +
      "approved on the consent screen, or an API token somebody pasted into a " +
      "terminal or IDE agent — both are ordinary API tokens, so `id` is that " +
      "token's id and revoking it is `revokeToken`, which deletes the " +
      "credential and disconnects the client from every team it reached.",
    fields: (t) => ({
      id: t.exposeID("id"),
      kind: t.exposeString("kind", {
        description:
          "`web` for an OAuth connector, listed from the moment it is approved. " +
          "`token` for a bearer credential, listed once it has actually called " +
          "`/api/mcp` — a token that merely could is not a connected client.",
      }),
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
      capabilities: t.exposeStringList("capabilities"),
      lastUsedAt: t.exposeString("lastUsedAt", { nullable: true }),
      mcpLastUsedAt: t.exposeString("mcpLastUsedAt", {
        nullable: true,
        description:
          "The last MCP call specifically. `lastUsedAt` also rises on GraphQL " +
          "and the deploy hook, so it cannot tell an agent from a CI job.",
      }),
      expired: t.exposeBoolean("expired"),
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
    description:
      "AI clients that can act in this team over MCP: the web connectors " +
      "approved here, plus every API token that has actually called `/api/mcp`.",
    resolve: () => listMcpConnections(),
  }),
  mcpConnected: t.boolean({
    // `loggedIn`, not `manage_mcp`: this answers one yes/no about a token the
    // caller has just minted, and the person who mints a token holds
    // `manage_tokens` — which is not `manage_mcp`. The real gate is inside
    // `mcpTokenConnected`, as always, and an id outside the caller's reach
    // reads `false` rather than erroring.
    authScopes: { loggedIn: true },
    description:
      "Has this API token spoken MCP yet? What the connect wizard waits on " +
      "before saying an agent is really connected.",
    args: { tokenId: t.arg.string({ required: true }) },
    resolve: (_p, a) => mcpTokenConnected(a.tokenId),
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
          Parameters<typeof mintMcpConnection>[0]["capabilities"] | undefined,
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
