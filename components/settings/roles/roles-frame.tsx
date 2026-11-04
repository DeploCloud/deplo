import { ShieldCheck } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";

export function RolesIndexEmpty({ canManage }: { canManage: boolean }) {
  return (
    <EmptyState
      icon={ShieldCheck}
      title="Pick a role to see what it grants"
      docs="roles.overview"
      description={
        canManage
          ? "Every role is on the left. Open one to change its permissions, everyone holding it is updated, or start a new one from scratch or from a role that already exists."
          : "Every role is on the left. Open one to see exactly what a member holding it can do."
      }
    />
  );
}

export function RolesHeader() {
  return (
    <PageHeader
      docs="roles.overview"
      title="Roles"
      description="What a member can do in this team. Assign a role to each member on the Members page."
    />
  );
}
