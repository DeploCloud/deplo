import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/current-user";
import { getTeamIdentity, listMyTeams } from "@/lib/data/teams";
import { TwoFactorRequiredError } from "@/lib/membership";
import { userHasPasskey } from "@/lib/passkey-policy";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";
import { NoTeamAccessScreen } from "@/components/teams/no-team-access";
import { NavigationHistoryTracker } from "@/components/layout/navigation-history";

export default async function FocusLayout(props: LayoutProps<"/[team]">) {
  const { team: addressed } = await props.params;
  const children = props.children;
  const user = await requireUser();
  const teams = await listMyTeams();
  if (teams.length === 0) redirect("/welcome");
  if (!teams.some((t) => t.slug === addressed)) {
    const byId = teams.find((t) => t.id === addressed);
    if (byId) redirect(`/${byId.slug}/new`);
    return <NoTeamAccessScreen teams={teams} />;
  }

  try {
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
      <div className="deplo-grid-bg pointer-events-none absolute inset-0" />
      <NavigationHistoryTracker />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
