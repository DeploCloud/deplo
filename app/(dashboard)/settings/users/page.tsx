import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isInstanceAdmin } from "@/lib/membership";
import { listAllUsers, listRegistrationLinks } from "@/lib/data/members";
import { viewerIsInstanceOwner } from "@/lib/data/instance-owner";
import { PageHeader } from "@/components/shared/page-header";
import { UsersPanel } from "@/components/settings/users-panel";

export const metadata = { title: "Settings · Users" };

export default async function SettingsUsersPage() {
  // The global Users list + registration links are instance-admin only.
  if (!(await isInstanceAdmin())) notFound();

  const [user, users, registrationLinks, viewerIsOwner] = await Promise.all([
    getCurrentUser(),
    listAllUsers(),
    listRegistrationLinks(),
    viewerIsInstanceOwner(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        description="Instance-wide user administration."
      />
      <UsersPanel
        users={users}
        links={registrationLinks}
        currentUserId={user?.id ?? ""}
        viewerIsOwner={viewerIsOwner}
      />
    </div>
  );
}
