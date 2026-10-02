import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings/settings-store";
import { listScopeTree } from "@/lib/data/tokens/scope-tree";
import { countMcpAgents } from "@/lib/data/mcp-clients";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { ConnectWizard } from "@/components/settings/mcp/connect-wizard/wizard";
import { McpSwitchMenu } from "@/components/settings/mcp/mcp-switch-menu";
import { MCP_TOOLS } from "@/lib/mcp/tools/catalog";

export const metadata = { title: "Settings · MCP Server" };

const TOOL_SUMMARIES = MCP_TOOLS.map((t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  group: t.group,
  requires: t.requires ?? null,
  destructive: t.destructive === true,
}));

export default async function McpSettingsPage() {
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="MCP Server"
        description="Connect your AI agents to this team over MCP, with an API token only you control."
        what="The MCP connect flow"
      />
    );

  const [settings, publicUrl, canConnect, canManageTeam, agentCount, tree] =
    await Promise.all([
      getMcpSettings(),
      instancePublicBaseUrl(),
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
