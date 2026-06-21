import { hasCapability } from "@/lib/membership";
import { getTeam } from "@/lib/data/teams";
import { DEPLO_VERSION } from "@/lib/version";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TeamForm } from "@/components/settings/team-form";
import { UpdateCard } from "@/components/settings/update-card";

export const metadata = { title: "Settings · General" };

export default async function SettingsGeneralPage() {
  const [team, canManageTeam] = await Promise.all([
    getTeam(),
    hasCapability("manage_team"),
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
            <CardTitle className="text-base">Team</CardTitle>
            <CardDescription>Your workspace details.</CardDescription>
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
            <CardTitle className="text-base">Appearance</CardTitle>
            <CardDescription>Switch between light and dark.</CardDescription>
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
      </div>
    </div>
  );
}
