import { ShieldCheck } from "lucide-react";
import { hasCapability } from "@/lib/membership";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata = { title: "Settings · Roles" };

export default async function RolesIndexPage() {
  const canManage = await hasCapability("manage_roles");
  return (
    <EmptyState
      icon={ShieldCheck}
      title="Pick a role to see what it grants"
      description={
        canManage
          ? "Every role is on the left. Open one to change its permissions — everyone holding it is updated — or start a new one from scratch or from a role that already exists."
          : "Every role is on the left. Open one to see exactly what a member holding it can do."
      }
    />
  );
}
