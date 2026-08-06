import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getTeamIdentity, listMyTeams } from "@/lib/data/teams";
import {
  reachableCapabilities,
  isInstanceAdmin,
  TwoFactorRequiredError,
} from "@/lib/membership";
import { getBreadcrumbGraph } from "@/lib/data/breadcrumb";
import { AppShell } from "@/components/layout/app-shell";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const teams = await listMyTeams();
  // A user can end up with zero teams (their last team was deleted, or they
  // were removed from it). The dashboard needs an active team, so route them
  // to the standalone create-team screen instead of throwing "No active team".
  if (teams.length === 0) redirect("/welcome");

  // Every load below is team-scoped, so all of them refuse when the active team
  // requires 2FA the account has not enrolled. Catching HERE and returning early
  // is what guarantees no page under this layout renders: a redirect would race
  // the children's own data loads, which fail the same way and would surface as
  // an error boundary instead of an explanation.
  let team, capabilities, isAdmin, breadcrumb;
  try {
    // The IDENTITY, not the settings: this runs on every page under the
    // layout, and `getTeam` is a team-wide read that a member limited to part
    // of the team is refused. Reading it here would take the whole dashboard
    // down for them, since the catch below only handles the 2FA case.
    team = await getTeamIdentity();
    [capabilities, isAdmin, breadcrumb] = await Promise.all([
      // What they could do SOMEWHERE in the team, not only team-wide: a
      // per-folder grant is exactly how someone holds one corner of the fleet
      // (ADR-0016), and a nav item hidden from them would hide the only apps
      // they have. Wider than the truth on purpose — nothing here decides
      // anything, every page and mutation re-checks per app.
      reachableCapabilities(),
      isInstanceAdmin(),
      getBreadcrumbGraph(),
    ]);
  } catch (e) {
    if (e instanceof TwoFactorRequiredError)
      return (
        <TwoFactorLockScreen
          reason={e.reason}
          otherTeams={teams
            .filter((t) => t.id !== e.teamId)
            .map((t) => ({ id: t.id, name: t.name }))}
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
    >
      {children}
    </AppShell>
  );
}
