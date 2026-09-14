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
  // The machine's ports still belong to another panel. See lib/data/takeover.ts.
  if (await takeoverBlocksDashboard()) redirect("/takeover");

  const teams = await listMyTeams();
  // Zero teams (last one deleted, or removed from it) would throw "No active team".
  if (teams.length === 0) redirect("/welcome");
  // The URL segment is what every read below resolves (proxy.ts sets the header), and an unknown team and a forbidden team get the SAME answer.
  if (!teams.some((t) => t.slug === addressed)) {
    const byId = teams.find((t) => t.id === addressed);
    if (byId) redirect(`/${byId.slug}`);
    return <NoTeamAccessScreen teams={teams} />;
  }

  // Every load below is team-scoped, so all refuse when the team requires 2FA the account lacks.
  let team, capabilities, isAdmin, breadcrumb;
  try {
    // The IDENTITY, not the settings: `getTeam` is a team-wide read a partial-reach member is refused.
    team = await getTeamIdentity();
    [capabilities, isAdmin, breadcrumb] = await Promise.all([
      // Reachable, not team-wide: a per-folder grant is how someone holds one corner of the fleet (ADR-0016).
      reachableCapabilities(),
      isInstanceAdmin(),
      getBreadcrumbGraph(),
    ]);
  } catch (e) {
    if (e instanceof TwoFactorRequiredError)
      return (
        <TwoFactorLockScreen
          reason={e.reason}
          // A usable passkey plus a block means this session signed in with the password.
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
