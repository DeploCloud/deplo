import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";
import { requireActiveTeamId } from "@/lib/membership";
import { listScopeTree } from "@/lib/data/tokens";
import { listMcpConnections } from "@/lib/data/mcp-clients";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { McpTabs } from "@/components/settings/mcp/mcp-tabs";
import { MCP_TOOLS } from "@/lib/mcp/tools";

export const metadata = { title: "Settings · MCP Server" };

/**
 * The tool table, flattened for the browser.
 *
 * `lib/mcp/tools.ts` is 55 KB of GraphQL documents and zod schemas. The dialog
 * renders six fields per tool, so those six fields are what crosses to the
 * client — importing the module into a client component would ship every tool's
 * query text to every reader of this page.
 */
const TOOL_SUMMARIES = MCP_TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  group: t.group,
  requires: t.requires ?? null,
  destructive: t.destructive === true,
}));

export default async function McpSettingsPage() {
  // The page governs the whole team, so a member who reaches only part of it
  // has no business here — same gate as API tokens, which this page is the twin
  // of.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="MCP Server"
        description="Let AI agents drive this team through deplo's API, using an API token you control."
        what="The team's MCP settings"
      />
    );

  const [
    settings,
    publicUrl,
    teamId,
    canManageMcp,
    // Two capabilities open two different halves of this page: `manage_mcp` is
    // the team's switch and approving a web connector, `manage_tokens` is
    // minting the credential a terminal agent connects with and revoking any of
    // them. The nav lets either one in, and the wizard disables the branch the
    // viewer cannot finish rather than failing at the last click.
    canManageTokens,
    connections,
    tree,
  ] = await Promise.all([
    getMcpSettings(),
    instancePublicBaseUrl(),
    requireActiveTeamId(),
    hasCapability("manage_mcp"),
    hasCapability("manage_tokens"),
    listMcpConnections(),
    listScopeTree(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            MCP Server
            <BetaChip />
          </span>
        }
        description="Let AI agents drive this team through deplo's API, using an API token you control."
      />
      <McpTabs
        enabled={settings.enabled}
        canManageMcp={canManageMcp}
        canManageTokens={canManageTokens}
        publicUrl={publicUrl}
        tree={tree}
        activeTeamId={teamId}
        tools={TOOL_SUMMARIES}
        connections={connections}
      />
    </div>
  );
}
