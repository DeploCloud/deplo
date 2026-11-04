import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getCurrentUser } from "@/lib/auth/current-user";
import {
  getTeam,
  getTeamIdentity,
  membersWithoutTwoFactor,
} from "@/lib/data/teams";
import { listMembers } from "@/lib/data/members/roster";
import { getMcpSettings } from "@/lib/data/mcp-settings";
import { countTeamMcpAgents } from "@/lib/data/mcp-clients";
import {
  dnsProviderTeamChoices,
  listMyDnsProviders,
} from "@/lib/data/dns-providers/store";
import { canDeleteTeam } from "@/lib/data/team-delete";
import { PageHeader } from "@/components/shared/page-header";
import { TeamCard } from "@/components/settings/team-form";
import { TeamSecurityCard } from "@/components/settings/team-security-card";
import { TeamAgentsCard } from "@/components/settings/team-agents-card";
import { TeamDnsCard } from "@/components/settings/dns/team-dns-card";
import { TeamDangerZone } from "@/components/settings/team-danger-zone";
import { EmptyState } from "@/components/shared/empty-state";
import { Lock } from "lucide-react";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  const wholeTeam = await reachesWholeTeam();
  const [team, canManageTeam, viewer] = await Promise.all([
    getTeamIdentity(),
    hasCapability("manage_team"),
    getCurrentUser(),
  ]);
  const [settings, deletion, twoFactor, extras] = wholeTeam
    ? await Promise.all([
        getTeam(),
        canDeleteTeam(),
        membersWithoutTwoFactor(),
        Promise.all([
          getMcpSettings(),
          countTeamMcpAgents(),
          listMyDnsProviders(),
          dnsProviderTeamChoices(),
        ]).then(([mcp, agents, dns, dnsTeams]) => ({
          mcp,
          agents,
          dns,
          dnsTeams,
        })),
      ])
    : [
        null,
        {
          allowed: false,
          onlyTeam: false,
          sharedVars: 0,
          sharedVarsOtherTeamsUse: 0,
        },
        { without: 0, total: 0 },
        null,
      ];

  const canTransfer =
    canManageTeam && !!viewer && settings?.founderUserId === viewer.id;
  const candidates =
    canTransfer && viewer
      ? (await listMembers())
          .filter((m) => m.userId !== viewer.id)
          .map((m) => ({
            userId: m.userId,
            username: m.username,
            name: m.name,
          }))
      : [];

  return (
    <div className="space-y-6">
      <PageHeader
        docs="team.overview"
        title="General"
        description="Your workspace details."
      />

      {settings && extras ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <TeamCard
            name={team.name}
            avatarUrl={team.avatarUrl}
            canManage={canManageTeam}
          />

          <TeamSecurityCard
            requireTwoFactor={settings.requireTwoFactor ?? false}
            canManage={canManageTeam}
            without={twoFactor.without}
            total={twoFactor.total}
          />

          <TeamAgentsCard
            enabled={extras.mcp.enabled}
            canManage={canManageTeam}
            agents={extras.agents}
          />

          <TeamDnsCard
            providers={extras.dns}
            teams={extras.dnsTeams}
            activeTeamId={team.id}
          />

          {(deletion.allowed || canTransfer) && (
            <div className="md:col-span-2 xl:col-span-3">
              <TeamDangerZone
                teamId={team.id}
                teamName={team.name}
                onlyTeam={deletion.onlyTeam}
                canDelete={deletion.allowed}
                sharedVars={deletion.sharedVars}
                sharedVarsOtherTeamsUse={deletion.sharedVarsOtherTeamsUse}
                canTransfer={canTransfer}
                candidates={candidates}
                viewerTwoFactorEnabled={viewer?.twoFactorEnabled ?? false}
              />
            </div>
          )}
        </div>
      ) : (
        <EmptyState
          icon={Lock}
          title="Outside your access"
          docs="roles.floorCeiling"
          description="Your role reaches part of this team, so its settings aren't yours to see."
        />
      )}
    </div>
  );
}
