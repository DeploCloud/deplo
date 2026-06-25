import { Skeleton } from "@/components/ui/skeleton";
import { EnvTableSkeleton } from "@/components/env/env-skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading variables" aria-busy>
      <div className="space-y-1">
        <Skeleton shimmer className="h-7 w-56" />
        <Skeleton shimmer className="h-4 w-96" />
      </div>

      <div className="flex items-center gap-6 border-b border-border">
        <Skeleton shimmer className="h-8 w-20" />
        <Skeleton shimmer className="h-8 w-20" />
      </div>

      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="rounded-xl border border-border">
            <div className="flex items-center justify-between p-6">
              <Skeleton shimmer className="h-5 w-40" />
              <Skeleton shimmer className="h-8 w-24 rounded-md" />
            </div>
            <div className="p-6 pt-0">
              <EnvTableSkeleton rows={3} actions={false} className="rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
