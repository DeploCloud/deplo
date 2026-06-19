import { Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { hasCapability } from "@/lib/membership";
import { listMembers } from "@/lib/data/members";
import { PageHeader } from "@/components/shared/page-header";
import { MembersManager } from "@/components/members/members-manager";

export const metadata = { title: "Team members" };

export default async function MembersPage() {
  const [user, members, canManage] = await Promise.all([
    getCurrentUser(),
    listMembers(),
    hasCapability("manage_members"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Users className="size-5" />
            Team members
          </span>
        }
        description="People who can access this team's projects and resources."
      />
      <MembersManager
        members={members}
        currentUserId={user?.id ?? ""}
        canManage={canManage}
      />
    </div>
  );
}
