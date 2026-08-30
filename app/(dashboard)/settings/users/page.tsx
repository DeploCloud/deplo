// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { isInstanceAdmin } from "@/lib/membership";
import { listAllUsers, listRegistrationLinks } from "@/lib/data/members";
import { UsersPanel } from "@/components/settings/users-panel";

export const metadata = { title: "Settings · Users" };

export default async function SettingsUsersPage() {
  // The global Users list + registration links are instance-admin only.
  if (!(await isInstanceAdmin())) notFound();

  // Ownership is NOT handed over from here any more: it moved to Settings, Deplo,
  // where it is a deliberate trip rather than a `⋯` entry under "Delete user".
  const [user, users, registrationLinks] = await Promise.all([
    getCurrentUser(),
    listAllUsers(),
    listRegistrationLinks(),
  ]);

  // The page header lives inside the panel: "Register user" belongs in it, and
  // only the panel can open the wizard it opens.
  return (
    <UsersPanel
      users={users}
      links={registrationLinks}
      currentUserId={user?.id ?? ""}
    />
  );
}
