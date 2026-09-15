import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/current-user";
import { getTeamIdentity, listMyTeams } from "@/lib/data/teams";
import {
  reachableCapabilities,
  isInstanceAdmin,
  TwoFactorRequiredError,
} from "@/lib/membership";
import { getBreadcrumbGraph } from "@/lib/data/breadcrumb";
import { takeoverBlocksDashboard } from "@/lib/data/takeover";
import { userHasPasskey } from "@/lib/passkey-policy";
import { AppShell } from "@/components/layout/app-shell";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";
import { NoTeamAccessScreen } from "@/components/teams/no-team-access";

export default async function DashboardLayout(props: LayoutProps<"/[team]">) {
  const { team: addressed } = await props.params;
  const children = props.children;
  const user = await requireUser();
  if (await takeoverBlocksDashboard()) redirect("/takeover");

  const teams = await listMyTeams();
  if (teams.length === 0) redirect("/welcome");
  if (!teams.some((t) => t.slug === addressed)) {
    const byId = teams.find((t) => t.id === addressed);
    if (byId) redirect(`/${byId.slug}`);
    return <NoTeamAccessScreen teams={teams} />;
  }

  let team, capabilities, isAdmin, breadcrumb;
  try {
    team = await getTeamIdentity();
    [capabilities, isAdmin, breadcrumb] = await Promise.all([
      reachableCapabilities(),
      isInstanceAdmin(),
      getBreadcrumbGraph(),
    ]);
  } catch (e) {
    if (e instanceof TwoFactorRequiredError)
      return (
        <TwoFactorLockScreen
          reason={e.reason}
          hasPasskey={await userHasPasskey(user.id)}
          otherTeams={teams
            .filter((t) => t.id !== e.teamId)
            .map((t) => ({
              id: t.id,
              name: t.name,
              slug: t.slug,
              avatarUrl: t.avatarUrl,
            }))}
        />
      );
    throw e;
  }

  return (
    <AppShell
      user={user}
      team={team}
      teams={teams}
      breadcrumb={breadcrumb}
      capabilities={capabilities}
      isAdmin={isAdmin}
      hasPasskey={await userHasPasskey(user.id)}
    >
      {children}
    </AppShell>
  );
}
