import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
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
import { TakeoverBanner } from "@/components/takeover/takeover-banner";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  // The machine's ports still belong to another panel, so there is nothing here
  // to deploy onto yet. See lib/data/takeover.ts.
  if (await takeoverBlocksDashboard()) redirect("/takeover");

  const teams = await listMyTeams();
  // A user can end up with zero teams (their last team was deleted, or they
  // were removed from it). The dashboard needs an active team, so route them
  // to the standalone create-team screen instead of throwing "No active team".
  if (teams.length === 0) redirect("/welcome");

  // Every load below is team-scoped, so all of them refuse when the active team
  // requires 2FA the account has not enrolled.
  let team, capabilities, isAdmin, breadcrumb;
  try {
    // The IDENTITY, not the settings: this runs on every page under the layout, and
    // `getTeam` is a team-wide read that a member limited to part of the team is
    // refused.
    team = await getTeamIdentity();
    [capabilities, isAdmin, breadcrumb] = await Promise.all([
      // What they could do SOMEWHERE in the team, not only team-wide: a per-folder grant
      // is exactly how someone holds one corner of the fleet (ADR-0016), and a nav item
      // hidden from them would hide the only apps they have.
      reachableCapabilities(),
      isInstanceAdmin(),
      getBreadcrumbGraph(),
    ]);
  } catch (e) {
    if (e instanceof TwoFactorRequiredError)
      return (
        <TwoFactorLockScreen
          reason={e.reason}
          // Owning a usable passkey and being blocked anyway means one thing:
          // this session signed in with the password. The screen says so rather
          // than suggesting they add what they already have.
          hasPasskey={await userHasPasskey(user.id)}
          otherTeams={teams
            .filter((t) => t.id !== e.teamId)
            .map((t) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl }))}
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
      <TakeoverBanner />
      {children}
    </AppShell>
  );
}
