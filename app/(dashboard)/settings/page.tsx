import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import {
  getTeam,
  getTeamIdentity,
  membersWithoutTwoFactor,
} from "@/lib/data/teams";
import { canDeleteTeam } from "@/lib/data/team-delete";
import { PageHeader } from "@/components/shared/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { TeamForm } from "@/components/settings/team-form";
import { TeamSecurityCard } from "@/components/settings/team-security-card";
import { DeleteTeamCard } from "@/components/settings/delete-team-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Lock } from "lucide-react";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  // The team's own settings are a team-wide read, so a member limited to part of
  // the team is refused them. A section they can't have says so instead of taking
  // the page down with it.
  const wholeTeam = await reachesWholeTeam();
  const [team, canManageTeam] = await Promise.all([
    getTeamIdentity(),
    hasCapability("manage_team"),
  ]);
  // The settings themselves, only for a principal who reaches the whole team.
  const [settings, deletion, twoFactor] = wholeTeam
    ? await Promise.all([getTeam(), canDeleteTeam(), membersWithoutTwoFactor()])
    : [null, { allowed: false, onlyTeam: false }, { without: 0, total: 0 }];

  return (
    <div className="space-y-6">
      <PageHeader
        docs="team.overview"
        title="General"
        description="Your workspace details."
      />

      {settings ? (
        // Direct grid children, so Team and Security share one row's height
        // instead of each ending wherever its own content stops.
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex w-fit items-center gap-2 text-base">
                Team
                <InfoTip
                  content="Your workspace details."
                  docs="team.overview"
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <TeamForm
                name={team.name}
                slug={team.slug}
                avatarUrl={team.avatarUrl}
                canManage={canManageTeam}
              />
            </CardContent>
          </Card>

          <TeamSecurityCard
            name={team.name}
            slug={team.slug}
            requireTwoFactor={settings.requireTwoFactor ?? false}
            canManage={canManageTeam}
            without={twoFactor.without}
            total={twoFactor.total}
          />

          {deletion.allowed && (
            <div className="lg:col-span-2">
              <DeleteTeamCard
                teamId={team.id}
                teamName={team.name}
                onlyTeam={deletion.onlyTeam}
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
