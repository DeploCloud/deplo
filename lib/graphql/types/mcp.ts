import { builder } from "../builder";
import {
  getMcpSettings,
  setMcpSettings,
  type McpSettings,
} from "@/lib/data/mcp-settings";
import {
  authorizeMcpClient,
  denyMcpClient,
  listMcpConnections,
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
      "that token's id, and revoking it is `revokeToken`.",
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
      capabilities: t.exposeStringList("capabilities"),
      lastUsedAt: t.exposeString("lastUsedAt", { nullable: true }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

export const OauthRedirectRef = builder
  .objectRef<{ redirectUrl: string }>("OauthRedirect")
  .implement({
    description: "Where to send the browser to finish the OAuth flow.",
    fields: (t) => ({ redirectUrl: t.exposeString("redirectUrl") }),
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
  authorizeMcpClient: t.field({
    type: OauthRedirectRef,
    authScopes: { capability: "manage_mcp" },
    description:
      "Approve an AI client's OAuth request: mint an API token with the chosen " +
      "capabilities and scope, and hand the client its authorization code. " +
      "Also needs `manage_tokens`, and cannot grant more than the approver holds.",
    args: {
      clientId: t.arg.string({ required: true }),
      capabilities: t.arg.stringList({ required: false }),
      teamIds: t.arg.stringList({ required: false }),
      projectIds: t.arg.stringList({ required: false }),
      folderIds: t.arg.stringList({ required: false }),
      appIds: t.arg.stringList({ required: false }),
      scope: t.arg.string({ required: false }),
      oauthQuery: t.arg.string({ required: false }),
    },
    resolve: (_p, a) =>
      authorizeMcpClient({
        clientId: a.clientId,
        capabilities: (a.capabilities ?? undefined) as
          | Parameters<typeof authorizeMcpClient>[0]["capabilities"]
          | undefined,
        teamIds: a.teamIds ?? undefined,
        projectIds: a.projectIds ?? undefined,
        folderIds: a.folderIds ?? undefined,
        appIds: a.appIds ?? undefined,
        scope: a.scope ?? undefined,
        oauthQuery: a.oauthQuery ?? undefined,
      }),
  }),
  denyMcpClient: t.field({
    type: OauthRedirectRef,
    authScopes: { loggedIn: true },
    description:
      "Turn down an AI client's OAuth request. Mints nothing; anyone signed in " +
      "may decline a request addressed to them.",
    args: { oauthQuery: t.arg.string({ required: false }) },
    resolve: (_p, a) => denyMcpClient({ oauthQuery: a.oauthQuery ?? undefined }),
  }),
}));
