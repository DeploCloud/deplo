import { redirect } from "next/navigation";
import { hasCapability } from "@/lib/membership";
import { getRole } from "@/lib/data/roles/role-list";
import { listTeamScopeTree } from "@/lib/data/tokens/scope-tree";
import { RoleEditor } from "@/components/settings/roles/role-editor";

export const metadata = { title: "Settings · New role" };

export default async function NewRolePage(
  props: PageProps<"/[team]/settings/roles/new">,
) {
  const { team } = await props.params;
  const sp = await props.searchParams;
  const from = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  const canManage = await hasCapability("manage_roles");
  if (!canManage) redirect(`/${team}/settings/roles`);
  const [basedOn, tree] = await Promise.all([
    from ? getRole(from) : null,
    listTeamScopeTree(),
  ]);

  return <RoleEditor mode="create" basedOn={basedOn} canManage tree={tree} />;
}
