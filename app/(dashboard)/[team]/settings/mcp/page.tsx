import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";
import { requireActiveTeamId } from "@/lib/membership";
import { listScopeTree } from "@/lib/data/tokens";
import { countMcpAgents } from "@/lib/data/mcp-clients";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { ConnectWizard } from "@/components/settings/mcp/connect-wizard";
import { McpSwitchMenu } from "@/components/settings/mcp/mcp-switch-menu";
import { MCP_TOOLS } from "@/lib/mcp/tools";

export const metadata = { title: "Settings · MCP Server" };

/**
 * The tool table, flattened for the browser.
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
  // The scope picker behind the wizard needs whole-team reach, so a narrowed
  // role stops here - same gate as API tokens, which this page mints.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="MCP Server"
        description="Connect your AI agents to this team over MCP, with an API token only you control."
        what="The MCP connect flow"
      />
    );

  const [
    settings,
    publicUrl,
    teamId,
    // Connecting YOUR agent is `manage_mcp`; the team's switch is `manage_team`.
    canConnect,
    canManageTeam,
    agentCount,
    tree,
  ] = await Promise.all([
    getMcpSettings(),
    instancePublicBaseUrl(),
    requireActiveTeamId(),
    hasCapability("manage_mcp"),
    hasCapability("manage_team"),
    countMcpAgents(),
    listScopeTree(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        docs="mcp.overview"
        title={
          <span className="flex items-center gap-2">
            MCP Server
            <BetaChip />
          </span>
        }
        description="Connect your AI agents to this team over MCP, with an API token only you control."
      />
      <ConnectWizard
        mcpEnabled={settings.enabled}
        canConnect={canConnect}
        canManageTeam={canManageTeam}
        publicUrl={publicUrl}
        tree={tree}
        activeTeamId={teamId}
        tools={TOOL_SUMMARIES}
        connectionCount={agentCount}
        overlay={
          <McpSwitchMenu
            count={agentCount}
            enabled={settings.enabled}
            canManage={canManageTeam}
          />
        }
      />
    </div>
  );
}
