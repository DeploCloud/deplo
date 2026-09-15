import { getCurrentUser } from "@/lib/auth/current-user";
import {
  hasCapability,
  isInstanceAdmin,
  reachesWholeTeam,
} from "@/lib/membership";
import { listMembers } from "@/lib/data/members/roster";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { MembersManager } from "@/components/members/members-manager";

export const metadata = { title: "Settings · Members" };

export default async function MembersPage() {
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

  return (
    <MembersManager
      members={members}
      currentUserId={user?.id ?? ""}
      canManage={canManage}
      isAdmin={isAdmin}
    />
  );
}
