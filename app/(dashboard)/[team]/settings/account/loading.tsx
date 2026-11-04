import { PageHeader } from "@/components/shared/page-header";
import { AccountPanelSkeleton } from "@/components/settings/account-panel";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy aria-label="Loading account">
      <PageHeader
        docs="team.security"
        title="Account"
        description="Your personal account details."
      />
      <AccountPanelSkeleton />
    </div>
  );
}
