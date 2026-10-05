import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings/settings-store";
import { listScopeTree } from "@/lib/data/tokens/scope-tree";
import { listMyMcpAgents } from "@/lib/data/mcp-clients";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { ConnectWizard } from "@/components/settings/mcp/connect-wizard/wizard";
import { McpSwitchMenu } from "@/components/settings/mcp/mcp-switch-menu";

export const metadata = { title: "Settings · MCP Server" };

export default async function McpSettingsPage() {
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="MCP Server"
        description="Connect your AI agents to this team over MCP, with an API token only you control."
        what="The MCP connect flow"
      />
    );

  const [settings, publicUrl, canConnect, canManageTeam, agents, tree] =
    await Promise.all([
      getMcpSettings(),
      instancePublicBaseUrl(),
      hasCapability("manage_mcp"),
      hasCapability("manage_team"),
      listMyMcpAgents(),
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
        actions={
          <McpSwitchMenu
            agents={agents}
            enabled={settings.enabled}
            canManage={canManageTeam}
          />
        }
      />
      <ConnectWizard
        mcpEnabled={settings.enabled}
        canConnect={canConnect}
        canManageTeam={canManageTeam}
        publicUrl={publicUrl}
        tree={tree}
        connectionCount={agents.length}
      />
    </div>
  );
}
