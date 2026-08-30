// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { getCurrentUser } from "@/lib/auth";
import { listMyPasskeys } from "@/lib/data/passkeys";
import { listMySessions } from "@/lib/data/sessions";
import { PageHeader } from "@/components/shared/page-header";
import { AccountPanel } from "@/components/settings/account-panel";

export const metadata = { title: "Settings · Account" };

export default async function SettingsAccountPage() {
  // Counts only: the Security shortcuts say whether a thing needs attention,
  // and the page that manages it is one click away.
  const [user, passkeys, sessions] = await Promise.all([
    getCurrentUser(),
    listMyPasskeys(),
    listMySessions(),
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
          passkeys={passkeys.length}
          sessions={sessions.length}
        />
      )}
    </div>
  );
}
