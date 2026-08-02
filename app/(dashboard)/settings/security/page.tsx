import { getCurrentUser } from "@/lib/auth";
import { twoFactorMandateForCurrentUser } from "@/lib/membership";
import { listMySessions } from "@/lib/data/sessions";
import { PageHeader } from "@/components/shared/page-header";
import { PasswordCard } from "@/components/settings/security/password-card";
import { TwoFactorCard } from "@/components/settings/security/two-factor-card";
import { SessionsCard } from "@/components/settings/security/sessions-card";

export const metadata = { title: "Settings · Security" };

/**
 * The account's own security settings. Deliberately NOT team-scoped (it is in
 * `NON_TEAM_SETTINGS_PREFIXES`): a member locked out of a team by that team's 2FA
 * policy has to be able to reach this page to get back in.
 */
export default async function SettingsSecurityPage() {
  const [user, requiredBy, sessions] = await Promise.all([
    getCurrentUser(),
    twoFactorMandateForCurrentUser(),
    listMySessions(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="How this account proves it is you, and where it is signed in."
      />
      {user && (
        <div className="space-y-4">
          {/* Ordered the way the account is actually protected: what you know,
              then the second factor on top of it, then who is currently holding
              a session on the strength of both. */}
          <PasswordCard twoFactorEnabled={user.twoFactorEnabled} />
          <TwoFactorCard
            enabled={user.twoFactorEnabled}
            requiredBy={requiredBy}
          />
          <SessionsCard sessions={sessions} />
        </div>
      )}
    </div>
  );
}
