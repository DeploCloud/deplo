import { getCurrentUser } from "@/lib/auth/current-user";
import { avatarUrlFor } from "@/lib/avatar";
import { listMyPasskeys } from "@/lib/data/passkeys";
import { listMySessions } from "@/lib/data/sessions";
import { PageHeader } from "@/components/shared/page-header";
import { AccountPanel } from "@/components/settings/account-panel";

export const metadata = { title: "Settings · Account" };

export default async function SettingsAccountPage() {
  const [user, passkeys, sessions] = await Promise.all([
    getCurrentUser(),
    listMyPasskeys(),
    listMySessions(),
  ]);
  const gravatar = user
    ? await avatarUrlFor({ image: "gravatar", email: user.email })
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        docs="team.security"
        title="Account"
        description="Your personal account details."
      />
      {user && (
        <AccountPanel
          user={user}
          gravatar={gravatar}
          passkeys={passkeys.length}
          sessions={sessions.length}
        />
      )}
    </div>
  );
}
