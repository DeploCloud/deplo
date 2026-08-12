import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";
import { getTeam } from "@/lib/data/teams";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { McpPanel } from "@/components/settings/mcp/mcp-panel";
import { ConnectSnippet } from "@/components/settings/mcp/connect-snippet";
import { ToolTable } from "@/components/settings/mcp/tool-table";

export const metadata = { title: "Settings · MCP Server" };

export default async function McpSettingsPage() {
  // The switches govern the whole team, so a member who reaches only part of it
  // has no business seeing them — same gate as API tokens, which this page is
  // the twin of.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="MCP Server"
        description="Let AI agents drive this team through deplo's API, using an API token you control."
        what="The team's MCP settings"
      />
    );

  const [settings, publicUrl, team, canManage] = await Promise.all([
    getMcpSettings(),
    instancePublicBaseUrl(),
    getTeam(),
    hasCapability("manage_mcp"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="MCP Server"
        description="Let AI agents drive this team through deplo's API, using an API token you control."
      />
      <McpPanel
        enabled={settings.enabled}
        confirmDestructive={settings.confirmDestructive}
        canManage={canManage}
      />
      <ConnectSnippet publicUrl={publicUrl} teamSlug={team.slug} />
      <ToolTable />
    </div>
  );
}
