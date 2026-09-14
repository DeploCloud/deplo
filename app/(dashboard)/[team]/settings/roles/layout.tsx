import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { listRoles } from "@/lib/data/roles/role-list";
import { PageHeader } from "@/components/shared/page-header";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { RolesRail } from "@/components/settings/roles/roles-rail";

// RolesLayout holds the rail so navigating between roles never re-renders it.
export default async function RolesLayout({
  children,
}: LayoutProps<"/[team]/settings/roles">) {
  // Guarded here, and returning rather than throwing: a throw took out the whole section, read-only viewer included.
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
