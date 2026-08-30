// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { getCurrentUser } from "@/lib/auth";
import {
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { listMembers } from "@/lib/data/members";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { MembersManager } from "@/components/members/members-manager";

export const metadata = { title: "Settings · Members" };

export default async function MembersPage() {
  // `listMembers` is team-wide and throws for a limited role. Asked first, so
  // the page says so instead of taking the error boundary.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="Members"
        description="People who can access this team's apps and resources."
        what="The member roster"
      />
    );

  const [user, members, canManage, isAdmin] = await Promise.all([
    getCurrentUser(),
    listMembers(),
    hasCapability("manage_members"),
    isInstanceAdmin(),
  ]);

  // The page header lives inside the manager: "Add member" belongs in it, and
  // only the manager can open the dialog it opens.
  return (
    <MembersManager
      members={members}
      currentUserId={user?.id ?? ""}
      canManage={canManage}
      isAdmin={isAdmin}
    />
  );
}
