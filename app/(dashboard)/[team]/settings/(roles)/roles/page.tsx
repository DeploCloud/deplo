import { hasCapability } from "@/lib/membership";
import { RolesIndexEmpty } from "@/components/settings/roles/roles-frame";

export const metadata = { title: "Settings · Roles" };

export default async function RolesIndexPage() {
  return <RolesIndexEmpty canManage={await hasCapability("manage_roles")} />;
}
