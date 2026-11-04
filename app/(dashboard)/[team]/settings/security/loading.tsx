import { PageHeader } from "@/components/shared/page-header";
import { SecurityTabs } from "@/components/settings/security/security-tabs";

export default function Loading() {
  return (
    <div className="space-y-3" aria-busy>
      <PageHeader
        docs="team.security"
        title="Security"
        description="How this account proves it is you, and where it is signed in."
      />
      <SecurityTabs
        loading
        twoFactorEnabled={false}
        requiredBy={null}
        passkeyStanding="none"
        passkeys={[]}
        sessions={[]}
        panelUrl={null}
        rpId={null}
      />
    </div>
  );
}
