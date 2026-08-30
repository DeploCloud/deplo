// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { notFound } from "next/navigation";
import { hasCapability } from "@/lib/membership";
import { getRole } from "@/lib/data/roles";
import { listTeamScopeTree } from "@/lib/data/tokens";
import { RoleEditor } from "@/components/settings/roles/role-editor";

export async function generateMetadata(
  props: PageProps<"/settings/roles/[id]">,
) {
  const { id } = await props.params;
  const role = await getRole(id);
  return { title: role ? `Settings · ${role.name}` : "Settings · Roles" };
}

export default async function RolePage(
  props: PageProps<"/settings/roles/[id]">,
) {
  const { id } = await props.params;
  const [role, canManage, tree] = await Promise.all([
    getRole(id),
    hasCapability("manage_roles"),
    listTeamScopeTree(),
  ]);
  // A role of another team resolves to nothing here, exactly as it does in the
  // data layer - there is no id to guess your way into.
  if (!role) notFound();

  return (
    <RoleEditor mode="edit" role={role} canManage={canManage} tree={tree} />
  );
}
