import { TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { ScopedActivitySkeleton } from "@/components/activity/scoped-activity-skeleton";

export default function Loading() {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-busy
      aria-label="Loading activity"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.section} className="w-17" />
        <TextLine
          type="text-sm leading-[1.6]"
          className="w-[25.5rem] max-w-full"
        />
      </div>
      <ScopedActivitySkeleton />
    </div>
  );
}
