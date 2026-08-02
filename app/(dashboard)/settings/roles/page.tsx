import { hasCapability } from "@/lib/membership";
import { listRoles } from "@/lib/data/roles";
import { PageHeader } from "@/components/shared/page-header";
import { RolesManager } from "@/components/settings/roles/roles-manager";

export const metadata = { title: "Settings · Roles" };

export default async function RolesPage() {
  const [roles, canManage] = await Promise.all([
    listRoles(),
    hasCapability("manage_members"),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roles"
        description="What a member can do in this team. Assign a role to each member on the Members page."
      />
      <RolesManager roles={roles} canManage={canManage} />
    </div>
  );
}
