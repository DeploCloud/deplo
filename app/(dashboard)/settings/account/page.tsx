import { getCurrentUser } from "@/lib/auth";
import { gravatarEnabled } from "@/lib/avatar";
import { listMyPasskeys } from "@/lib/data/passkeys";
import { listMySessions } from "@/lib/data/sessions";
import { PageHeader } from "@/components/shared/page-header";
import { AccountPanel } from "@/components/settings/account-panel";

export const metadata = { title: "Settings · Account" };

export default async function SettingsAccountPage() {
  // Counts only: the Security shortcuts say whether a thing needs attention,
  // and the page that manages it is one click away.
  const [user, passkeys, sessions, gravatar] = await Promise.all([
    getCurrentUser(),
    listMyPasskeys(),
    listMySessions(),
    gravatarEnabled(),
  ]);

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
