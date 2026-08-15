import { getCurrentUser } from "@/lib/auth";
import { twoFactorMandateForCurrentUser } from "@/lib/membership";
import { userHasPasskey } from "@/lib/passkey-policy";
import { passkeyRelyingParty, publicBaseUrl } from "@/lib/public-url";
import { listMySessions } from "@/lib/data/sessions";
import { listMyPasskeys } from "@/lib/data/passkeys";
import { PageHeader } from "@/components/shared/page-header";
import { PasswordCard } from "@/components/settings/security/password-card";
import { TwoFactorCard } from "@/components/settings/security/two-factor-card";
import { PasskeysCard } from "@/components/settings/security/passkeys-card";
import { SessionsCard } from "@/components/settings/security/sessions-card";

export const metadata = { title: "Settings · Security" };

/**
 * The account's own security settings. Deliberately NOT team-scoped (it is in
 * `NON_TEAM_SETTINGS_PREFIXES`): a member locked out of a team by that team's 2FA
 * policy has to be able to reach this page to get back in.
 */
export default async function SettingsSecurityPage() {
  const [user, requiredBy, sessions, passkeys] = await Promise.all([
    getCurrentUser(),
    twoFactorMandateForCurrentUser(),
    listMySessions(),
    listMyPasskeys(),
  ]);
  // A passkey satisfies the same mandate (ADR-0024), so it is what makes turning
  // the authenticator app off allowed under a policy. Resolved here rather than
  // inside `twoFactorMandateForCurrentUser`, which answers a different question
  // ("which policy is in force") that other callers still need answered.
  const hasPasskey = user ? await userHasPasskey(user.id) : false;
  const rp = passkeyRelyingParty();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Security"
        description="How this account proves it is you, and where it is signed in."
      />
      {user && (
        <div className="space-y-4">
          {/* Ordered the way the account is actually protected: what you know,
              then the two things that can stand as a second factor, then who is
              currently holding a session on the strength of them. */}
          <PasswordCard twoFactorEnabled={user.twoFactorEnabled} />
          <TwoFactorCard
            enabled={user.twoFactorEnabled}
            requiredBy={hasPasskey ? null : requiredBy}
            satisfiedByPasskey={hasPasskey && requiredBy !== null}
          />
          <PasskeysCard
            passkeys={passkeys}
            panelUrl={publicBaseUrl()}
            rpId={rp?.rpId ?? null}
          />
          <SessionsCard sessions={sessions} />
        </div>
      )}
    </div>
  );
}
