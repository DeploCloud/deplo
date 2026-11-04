import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { getTeamIdentity } from "@/lib/data/teams";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings/settings-store";
import { listScopeTree } from "@/lib/data/tokens/scope-tree";
import { listAllMyMcpAgents } from "@/lib/data/mcp-clients";
import {
  AGENTS_DESCRIPTION,
  AgentsHeader,
} from "@/components/settings/mcp/agents-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { ConnectWizard } from "@/components/settings/mcp/connect-wizard/wizard";
import { MyAgents } from "@/components/settings/mcp/my-agents";

export const metadata = { title: "Settings · AI agents" };

export default async function AiAgentsPage() {
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="AI agents"
        description={AGENTS_DESCRIPTION}
        what="The MCP connect flow"
      />
    );

  const [settings, team, publicUrl, canConnect, canManageTeam, agents, tree] =
    await Promise.all([
      getMcpSettings(),
      getTeamIdentity(),
      instancePublicBaseUrl(),
      hasCapability("manage_mcp"),
      hasCapability("manage_team"),
      listAllMyMcpAgents(),
      listScopeTree(),
    ]);

  return (
    <div className="space-y-6">
      <AgentsHeader actions={<MyAgents agents={agents} />} />
      <ConnectWizard
        mcpEnabled={settings.enabled}
        canConnect={canConnect}
        canManageTeam={canManageTeam}
        teamName={team.name}
        publicUrl={publicUrl}
        tree={tree}
        connectionCount={agents.length}
      />
    </div>
  );
}
