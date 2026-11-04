import { PageHeader } from "@/components/shared/page-header";
import { ScopedActivitySkeleton } from "@/components/activity/scoped-activity-skeleton";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy>
      <PageHeader
        level="section"
        title="Activity"
        docs="team.activity"
        description="Everything that happened to this database, newest first."
      />
      <ScopedActivitySkeleton />
    </div>
  );
}
