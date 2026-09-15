import { Lock } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";

export function OutsideYourAccess({
  title,
  description,
  what,
}: {
  title: string;
  description: string;
  what: string;
}) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        docs="roles.floorCeiling"
      />
      <EmptyState
        icon={Lock}
        title="Outside your access"
        description={`Your role reaches part of this team. ${what} belongs to the whole of it.`}
      />
    </div>
  );
}
