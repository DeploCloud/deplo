import { getCurrentUser } from "@/lib/auth/current-user";
import { twoFactorMandateForCurrentUser } from "@/lib/membership";
import {
  passkeyCountsForThisRequest,
  userHasPasskey,
} from "@/lib/passkey-policy";
import { passkeyRelyingParty, publicBaseUrl } from "@/lib/public-url";
import { listMySessions } from "@/lib/data/sessions";
import { listMyPasskeys } from "@/lib/data/passkeys";
import { PageHeader } from "@/components/shared/page-header";
import { SecurityTabs } from "@/components/settings/security/security-tabs";

export const metadata = { title: "Settings · Security" };

export default async function SettingsSecurityPage() {
  const [user, requiredBy, sessions, passkeys] = await Promise.all([
    getCurrentUser(),
    twoFactorMandateForCurrentUser(),
    listMySessions(),
    listMyPasskeys(),
  ]);
  const hasPasskey = user ? await userHasPasskey(user.id) : false;
  const passkeyStanding = !hasPasskey
    ? ("none" as const)
    : (await passkeyCountsForThisRequest())
      ? ("carrying" as const)
      : ("idle" as const);
  const rp = passkeyRelyingParty();

  return (
    <div className="space-y-3">
      <PageHeader
        docs="team.security"
        title="Security"
        description="How this account proves it is you, and where it is signed in."
      />
      {user && (
        <SecurityTabs
          twoFactorEnabled={user.twoFactorEnabled}
          requiredBy={hasPasskey ? null : requiredBy}
          passkeyStanding={passkeyStanding}
          passkeys={passkeys}
          sessions={sessions}
          panelUrl={publicBaseUrl()}
          rpId={rp?.rpId ?? null}
        />
      )}
    </div>
  );
}
