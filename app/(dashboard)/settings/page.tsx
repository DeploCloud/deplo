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
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TeamForm } from "@/components/settings/team-form";
import { TeamSecurityCard } from "@/components/settings/team-security-card";
import { DeleteTeamCard } from "@/components/settings/delete-team-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Lock } from "lucide-react";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  // The team's own settings are a team-wide read, so a member limited to part of
  // the team is refused them. The page still renders: Appearance is theirs, and a
  // section they can't have says so instead of taking the page down with it.
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
        description="Your workspace details and appearance."
      />

      {settings ? (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {/* The team and the way it is taken apart belong on the same side. */}
          <div className="space-y-4">
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

            {deletion.allowed && (
              <DeleteTeamCard
                teamId={team.id}
                teamName={team.name}
                onlyTeam={deletion.onlyTeam}
              />
            )}
          </div>

          <div className="space-y-4">
            <TeamSecurityCard
              name={team.name}
              slug={team.slug}
              requireTwoFactor={settings.requireTwoFactor ?? false}
              canManage={canManageTeam}
              without={twoFactor.without}
              total={twoFactor.total}
            />
            <AppearanceCard />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <EmptyState
            icon={Lock}
            title="Outside your access"
            docs="roles.floorCeiling"
            description="Your role reaches part of this team, so its settings aren't yours to see."
          />
          <AppearanceCard />
        </div>
      )}
    </div>
  );
}

function AppearanceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Appearance
          <InfoTip content="Switch between light and dark." />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">Theme</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Defaults to dark, matches your system if enabled.
            </p>
          </div>
          <ThemeToggle />
        </div>
      </CardContent>
    </Card>
  );
}
