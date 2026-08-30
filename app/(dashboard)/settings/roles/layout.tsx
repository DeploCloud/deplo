// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { listRoles } from "@/lib/data/roles";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { RolesRail } from "@/components/settings/roles/roles-rail";

/**
 * Roles is a master-detail section, not a page with dialogs: the team's roles
 * stay listed on the left while one of them is open on the right. The rail lives
 * here so navigating between roles never re-renders it.
 */
export default async function RolesLayout({
  children,
}: LayoutProps<"/settings/roles">) {
  // The guard belongs in the LAYOUT, not the pages under it: this runs before
  // every child, so a throw here took out the whole section - the read-only role
  // viewer included.
  if (!(await reachesWholeTeam()))
    return (
      <OutsideYourAccess
        title="Roles"
        description="What a member can do in this team. Assign a role to each member on the Members page."
        what="The team's roles"
      />
    );

  const [roles, canManage] = await Promise.all([
    listRoles(),
    hasCapability("manage_roles"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        docs="roles.overview"
        title="Roles"
        description="What a member can do in this team. Assign a role to each member on the Members page."
      />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(220px,260px)_1fr]">
        <RolesRail roles={roles} canManage={canManage} />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
