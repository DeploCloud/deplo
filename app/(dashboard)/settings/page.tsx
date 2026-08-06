import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import {
  getTeam,
  getTeamIdentity,
  membersWithoutTwoFactor,
} from "@/lib/data/teams";
import { canDeleteTeam } from "@/lib/data/team-delete";
import { DEPLO_VERSION } from "@/lib/version";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TeamForm } from "@/components/settings/team-form";
import { TeamSecurityCard } from "@/components/settings/team-security-card";
import { UpdateCard } from "@/components/settings/update-card";
import { DeleteTeamCard } from "@/components/settings/delete-team-card";
import { EmptyState } from "@/components/shared/empty-state";
import { Lock } from "lucide-react";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  // The team's own settings are a team-wide read, so a member limited to part of
  // the team is refused them. The page still renders: Appearance is theirs and
  // the version is the instance's, and a section they can't have says so instead
  // of taking the page down with it.
  const wholeTeam = await reachesWholeTeam();
  const [team, canManageTeam] = await Promise.all([
    getTeamIdentity(),
    hasCapability("manage_team"),
  ]);
  // The settings themselves, only for a principal who reaches the whole team.
  // Kept separate from the identity above rather than branched into one value:
  // `null` is then the honest type for "not yours", and the sections that need
  // it are exactly the ones that render inside its check.
  const [settings, deletion, twoFactor] = wholeTeam
    ? await Promise.all([getTeam(), canDeleteTeam(), membersWithoutTwoFactor()])
    : [null, { allowed: false, onlyTeam: false }, { without: 0, total: 0 }];

  return (
    <div className="space-y-6">
      <PageHeader
        title="General"
        description="Your workspace details and appearance."
      />

      <div className="space-y-4">
        {settings ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle className="flex w-fit items-center gap-2 text-base">
                  Team
                  <InfoTip content="Your workspace details." />
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <TeamForm
                  name={team.name}
                  slug={team.slug}
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
          </>
        ) : (
          <EmptyState
            icon={Lock}
            title="Outside your access"
            description="Your role reaches part of this team, so its settings aren't yours to see."
          />
        )}

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

        <UpdateCard current={DEPLO_VERSION} />

        {deletion.allowed && (
          <DeleteTeamCard
            teamId={team.id}
            teamName={team.name}
            onlyTeam={deletion.onlyTeam}
          />
        )}
      </div>
    </div>
  );
}
