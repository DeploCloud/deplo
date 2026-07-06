import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading deployment"
    >
      {/* Back to project (ghost, size sm) */}
      <Skeleton className="-ml-2 h-8 w-36 rounded-md" />

      {/* Summary card */}
      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {/* Status */}
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-5 w-24 rounded-md" />
          </div>
          {/* Environment */}
          <div>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-1 h-5 w-20 rounded-md" />
          </div>
          {/* Source */}
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-36" />
          </div>
          {/* Build time */}
          <div>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-1 h-4 w-16" />
          </div>
          {/* Commit message (spans two columns) */}
          <div className="sm:col-span-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-3/4" />
          </div>
          {/* Created */}
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-40" />
          </div>
          {/* Visit (outline, size sm) */}
          <div className="flex items-end">
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </CardContent>
      </Card>

      {/* Build logs */}
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Skeleton className="h-3 w-16" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>
          <div className="max-h-120 space-y-2 p-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton shimmer className="h-3 w-14 shrink-0" />
                <Skeleton shimmer className="h-3 w-12 shrink-0 rounded" />
                <Skeleton shimmer className="h-3 flex-1" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
