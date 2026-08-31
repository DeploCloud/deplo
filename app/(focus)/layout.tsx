import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { getTeamIdentity, listMyTeams } from "@/lib/data/teams";
import { TwoFactorRequiredError } from "@/lib/membership";
import { userHasPasskey } from "@/lib/passkey-policy";
import { TwoFactorLockScreen } from "@/components/settings/security/two-factor-lock-screen";

/**
 * The dashboard's gate without its shell: a route that wants the whole window
 * (the new-app wizard) still needs a signed-in user, a team, and the same
 * two-factor refusal - it just has no sidebar to hang them off.
 */
export default async function FocusLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const teams = await listMyTeams();
  if (teams.length === 0) redirect("/welcome");

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
            .map((t) => ({ id: t.id, name: t.name, avatarUrl: t.avatarUrl }))}
        />
      );
    throw e;
  }

  return (
    <div className="relative min-h-dvh">
      <div className="deplo-graph-bg pointer-events-none absolute inset-0 opacity-[0.5]" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
