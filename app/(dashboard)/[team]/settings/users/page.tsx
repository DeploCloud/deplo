import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isInstanceAdmin } from "@/lib/membership";
import { listAllUsers } from "@/lib/data/members/instance-users";
import { listRegistrationLinks } from "@/lib/data/members/registration-links";
import { UsersPanel } from "@/components/settings/users-panel";

export const metadata = { title: "Settings · Users" };

export default async function SettingsUsersPage() {
  if (!(await isInstanceAdmin())) notFound();

  const [user, users, registrationLinks] = await Promise.all([
    getCurrentUser(),
    listAllUsers(),
    listRegistrationLinks(),
  ]);

  return (
    <UsersPanel
      users={users}
      links={registrationLinks}
      currentUserId={user?.id ?? ""}
    />
  );
}
