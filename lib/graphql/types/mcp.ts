import { builder } from "../builder";
import {
  getMcpSettings,
  setMcpSettings,
  type McpSettings,
} from "@/lib/data/mcp-settings";
import {
  countMcpAgents,
  listMcpTeams,
  mcpTokenConnected,
  mintMcpConnection,
  type McpTeamDTO,
} from "@/lib/data/mcp-clients";

/* ------------------------------------------------------------------ */
/* Object types                                                        */
/* ------------------------------------------------------------------ */

export const McpSettingsRef = builder
  .objectRef<McpSettings>("McpSettings")
  .implement({
    description:
      "The active team's MCP policy: whether AI agents may drive it at all. " +
      "What an agent may DO is decided by its API token's capabilities and by " +
      "its owner's `manage_mcp` in the team, and by nothing here.",
    fields: (t) => ({
      enabled: t.exposeBoolean("enabled"),
    }),
  });

export const McpTeamRef = builder.objectRef<McpTeamDTO>("McpTeam").implement({
  description:
    "A team as the MCP server names it: whether the team allows agents at " +
    "all, and whether the caller may connect theirs.",
  fields: (t) => ({
    id: t.exposeID("id"),
    name: t.exposeString("name"),
    slug: t.exposeString("slug"),
    mcpEnabled: t.exposeBoolean("mcpEnabled", {
      description: "The team's own MCP switch.",
    }),
    canConnect: t.exposeBoolean("canConnect", {
      description: "Whether the caller holds `manage_mcp` in this team.",
    }),
  }),
});

/* ------------------------------------------------------------------ */
/* Queries                                                             */
/* ------------------------------------------------------------------ */

builder.queryFields((t) => ({
  mcpSettings: t.field({
    type: McpSettingsRef,
    authScopes: { loggedIn: true },
    description: "The active team's MCP policy.",
    resolve: () => getMcpSettings(),
  }),
  mcpTeams: t.field({
    type: [McpTeamRef],
    authScopes: { loggedIn: true },
    description:
      "Every team the caller's credential can name, and whether MCP may act " +
      "in each: the team's switch and the caller's `manage_mcp` there.",
    resolve: () => listMcpTeams(),
  }),
  mcpAgentCount: t.int({
    authScopes: { loggedIn: true },
    description:
      "How many AI agents can act in this team over MCP, every member's " +
      "counted. A number only: tokens are personal and never listed to " +
      "anyone but their owner.",
    resolve: () => countMcpAgents(),
  }),
  mcpConnected: t.boolean({
    // `loggedIn`, not `manage_mcp`: this answers one yes/no about a token the caller
    // has just minted, and the person who mints a token holds `manage_tokens`, which
    // is not `manage_mcp`.
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
    authScopes: { capability: "manage_team" },
    description:
      "Turn MCP access on or off for this team - a team setting, so it " +
      "needs `manage_team`.",
    args: {
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: (_p, a) => setMcpSettings({ enabled: a.enabled }),
  }),
  authorizeMcpClient: t.boolean({
    authScopes: { loggedIn: true },
    description:
      "Approve an AI client: mint a personal API token with the chosen " +
      "capabilities and scope, and link it to the client. It cannot grant more " +
      "than the approver holds. The OAuth handshake itself is then finished by " +
      "the browser posting to `/api/auth/oauth2/consent` - that endpoint " +
      "refuses a server-side call, so it cannot be done here. `teamIds` names " +
      "the teams the connection may work in, each gated on `manage_mcp` there; " +
      "naming nothing means every team the approver may connect agents to, live.",
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
          "The team the consent screen showed. Not a choice - the server takes " +
          "the team from the session, but a disagreement is refused rather " +
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
