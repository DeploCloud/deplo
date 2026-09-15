import { notFound } from "next/navigation";
import { hasCapability } from "@/lib/membership";
import { getRole } from "@/lib/data/roles/role-list";
import { listTeamScopeTree } from "@/lib/data/tokens/scope-tree";
import { RoleEditor } from "@/components/settings/roles/role-editor";

export async function generateMetadata(
  props: PageProps<"/[team]/settings/roles/[id]">,
) {
  const { id } = await props.params;
  const role = await getRole(id);
  return { title: role ? `Settings · ${role.name}` : "Settings · Roles" };
}

export default async function RolePage(
  props: PageProps<"/[team]/settings/roles/[id]">,
) {
  const { id } = await props.params;
  const [role, canManage, tree] = await Promise.all([
    getRole(id),
    hasCapability("manage_roles"),
    listTeamScopeTree(),
  ]);
  if (!role) notFound();

  return (
    <RoleEditor mode="edit" role={role} canManage={canManage} tree={tree} />
  );
}
