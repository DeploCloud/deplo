import { hasCapability } from "@/lib/membership";
import { getTeam } from "@/lib/data/teams";
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
import { UpdateCard } from "@/components/settings/update-card";
import { DeleteTeamCard } from "@/components/settings/delete-team-card";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  const [team, canManageTeam, deletion] = await Promise.all([
    getTeam(),
    hasCapability("manage_team"),
    canDeleteTeam(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="General"
        description="Your workspace details and appearance."
      />

      <div className="space-y-4">
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
                <p className="text-xs text-muted-foreground">
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
