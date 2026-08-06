import { redirect } from "next/navigation";
import { hasCapability } from "@/lib/membership";
import { getRole } from "@/lib/data/roles";
import { listTeamScopeTree } from "@/lib/data/tokens";
import { RoleEditor } from "@/components/settings/roles/role-editor";

export const metadata = { title: "Settings · New role" };

export default async function NewRolePage(props: PageProps<"/settings/roles/new">) {
  const sp = await props.searchParams;
  const from = Array.isArray(sp.from) ? sp.from[0] : sp.from;
  const canManage = await hasCapability("manage_roles");
  // Reachable only from the "New role" menu, which is itself gated — but a typed
  // URL must not open an editor whose save can only fail.
  if (!canManage) redirect("/settings/roles");
  // `?from=` is the base chosen in that menu. A stale or foreign id degrades to a
  // blank role rather than erroring: the choice is a starting point, not a link.
  const [basedOn, tree] = await Promise.all([
    from ? getRole(from) : null,
    listTeamScopeTree(),
  ]);

  return (
    <RoleEditor mode="create" basedOn={basedOn} canManage tree={tree} />
  );
}
