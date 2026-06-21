import { getCurrentUser } from "@/lib/auth";
import { PageHeader } from "@/components/shared/page-header";
import { AccountPanel } from "@/components/settings/account-panel";

export const metadata = { title: "Settings · Account" };

export default async function SettingsAccountPage() {
  const user = await getCurrentUser();

  return (
    <div className="space-y-6">
      <PageHeader title="Account" description="Your personal account details." />
      {user && <AccountPanel user={user} />}
    </div>
  );
}
