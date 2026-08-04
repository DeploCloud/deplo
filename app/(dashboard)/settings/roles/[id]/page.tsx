import { notFound } from "next/navigation";
import { hasCapability } from "@/lib/membership";
import { getRole, listRoles } from "@/lib/data/roles";
import { listMembers } from "@/lib/data/members";
import { RoleEditor } from "@/components/settings/roles/role-editor";
import { RoleMembersCard } from "@/components/settings/roles/role-members-card";

export async function generateMetadata(props: PageProps<"/settings/roles/[id]">) {
  const { id } = await props.params;
  const role = await getRole(id);
  return { title: role ? `Settings · ${role.name}` : "Settings · Roles" };
}

export default async function RolePage(props: PageProps<"/settings/roles/[id]">) {
  const { id } = await props.params;
  const [role, roles, members, canManage, canManageMembers] = await Promise.all([
    getRole(id),
    listRoles(),
    listMembers(),
    hasCapability("manage_roles"),
    // Editing what a role GRANTS and choosing who HOLDS it are different
    // permissions, so the card gates on its own.
    hasCapability("manage_members"),
  ]);
  // A role of another team resolves to nothing here, exactly as it does in the
  // data layer — there is no id to guess your way into.
  if (!role) notFound();

  return (
    <RoleEditor
      mode="edit"
      role={role}
      canManage={canManage}
      members={
        <RoleMembersCard
          role={role}
          members={members
            .filter((m) => m.roleId === role.id)
            .map((m) => ({
              userId: m.userId,
              username: m.username,
              name: m.name,
              avatarColor: m.avatarColor,
              isPrimaryOwner: m.isPrimaryOwner,
              isInstanceAdmin: m.isInstanceAdmin,
            }))}
          roles={roles}
          canManageMembers={canManageMembers}
        />
      }
    />
  );
}
