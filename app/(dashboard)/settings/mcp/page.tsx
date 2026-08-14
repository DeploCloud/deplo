import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { instancePublicBaseUrl } from "@/lib/data/instance-settings";
import { getTeam } from "@/lib/data/teams";
import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { McpPanel } from "@/components/settings/mcp/mcp-panel";
import { ConnectWeb } from "@/components/settings/mcp/connect-web";
import { ConnectSnippet } from "@/components/settings/mcp/connect-snippet";
import { ConnectedClients } from "@/components/settings/mcp/connected-clients";
import { ToolTable } from "@/components/settings/mcp/tool-table";
import { listMcpConnections } from "@/lib/data/mcp-clients";

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

  const [settings, publicUrl, team, canManage, canRevoke, connections] =
    await Promise.all([
      getMcpSettings(),
      instancePublicBaseUrl(),
      getTeam(),
      hasCapability("manage_mcp"),
      // Revoking a connection IS revoking its API token, so it is gated on
      // `manage_tokens` — not on the capability that governs the switch above.
      // Showing the button to someone who cannot use it is a promise the server
      // then breaks.
      hasCapability("manage_tokens"),
      listMcpConnections(),
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
      <McpPanel enabled={settings.enabled} canManage={canManage} />
      {/* The web case leads: it is the one that does not work without this, and
          it is a single copied line. The terminal snippet stays below it for
          anyone already living in a shell. */}
      <ConnectWeb publicUrl={publicUrl} />
      <ConnectSnippet publicUrl={publicUrl} teamSlug={team.slug} />
      <ConnectedClients
        connections={connections}
        activeTeamId={team.id}
        canManage={canRevoke}
      />
      <ToolTable />
    </div>
  );
}
