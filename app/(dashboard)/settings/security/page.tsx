import { getCurrentUser } from "@/lib/auth";
import { twoFactorMandateForCurrentUser } from "@/lib/membership";
import { PageHeader } from "@/components/shared/page-header";
import { TwoFactorCard } from "@/components/settings/security/two-factor-card";

export const metadata = { title: "Settings · Security" };

/**
 * The account's own security settings. Deliberately NOT team-scoped (it is in
 * `NON_TEAM_SETTINGS_PREFIXES`): a member locked out of a team by that team's 2FA
 * policy has to be able to reach this page to get back in.
 */
export default async function SettingsSecurityPage() {
  const user = await getCurrentUser();
  const requiredBy = await twoFactorMandateForCurrentUser();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="How this account proves it is you."
      />
      {user && (
        <TwoFactorCard
          enabled={user.twoFactorEnabled}
          requiredBy={requiredBy}
        />
      )}
    </div>
  );
}
