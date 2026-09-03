import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { getTeamIdentity, listMyTeams } from "@/lib/data/teams";
import { TwoFactorRequiredError } from "@/lib/membership";
import { userHasPasskey } from "@/lib/passkey-policy";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";
import { NoTeamAccessScreen } from "@/components/teams/no-team-access";
import { NavigationHistoryTracker } from "@/components/layout/navigation-history";

/**
 * The dashboard's gate without its shell: a route that wants the whole window
 * (the new-app wizard) still needs a signed-in user, a team, and the same
 * two-factor refusal - it just has no sidebar to hang them off.
 */
export default async function FocusLayout(props: LayoutProps<"/[team]">) {
  const { team: addressed } = await props.params;
  const children = props.children;
  const user = await requireUser();
  const teams = await listMyTeams();
  if (teams.length === 0) redirect("/welcome");
  // The same refusal the dashboard layout gives, for the same reason.
  if (!teams.some((t) => t.slug === addressed)) {
    const byId = teams.find((t) => t.id === addressed);
    if (byId) redirect(`/${byId.slug}/new`);
    return <NoTeamAccessScreen teams={teams} />;
  }

  try {
    // Team-scoped, so it refuses when the active team requires a second factor
    // the account has not enrolled - exactly like the dashboard layout.
    await getTeamIdentity();
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
    <div className="relative min-h-dvh">
      <div className="deplo-graph-bg pointer-events-none absolute inset-0 opacity-[0.5]" />
      {/* The shell isn't here to mount it, and an unrecorded entry makes the
          sidebar's back links land back ON the wizard. */}
      <NavigationHistoryTracker />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
