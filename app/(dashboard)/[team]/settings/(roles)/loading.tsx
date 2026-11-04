import { RolesHeader } from "@/components/settings/roles/roles-frame";
import { RolesRailSkeleton } from "@/components/settings/roles/roles-rail";
import { RolePaneSkeleton } from "@/components/settings/roles/role-editor";

export default function Loading() {
  return (
    <div className="space-y-6" aria-busy>
      <RolesHeader />
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(220px,260px)_1fr]">
        <RolesRailSkeleton />
        <div className="min-w-0">
          <RolePaneSkeleton />
        </div>
      </div>
    </div>
  );
}
