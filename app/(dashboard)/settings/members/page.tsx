import { getCurrentUser } from "@/lib/auth";
import { hasCapability, isInstanceAdmin } from "@/lib/membership";
import { listMembers } from "@/lib/data/members";
import { listRoles } from "@/lib/data/roles";
import { PageHeader } from "@/components/shared/page-header";
import { MembersManager } from "@/components/members/members-manager";

export const metadata = { title: "Settings · Members" };

export default async function MembersPage() {
  const [user, members, roles, canManage, isAdmin] = await Promise.all([
    getCurrentUser(),
    listMembers(),
    listRoles(),
    hasCapability("manage_members"),
    isInstanceAdmin(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Members"
        description="People who can access this team's apps and resources."
      />
      <MembersManager
        members={members}
        roles={roles}
        currentUserId={user?.id ?? ""}
        canManage={canManage}
        isAdmin={isAdmin}
      />
    </div>
  );
}
