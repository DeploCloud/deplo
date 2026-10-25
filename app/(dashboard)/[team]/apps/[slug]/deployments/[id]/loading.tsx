import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { LogLines, LogLinesSkeleton } from "@/components/shared/log-line-row";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading deployment"
    >
      <Skeleton className="-ml-2 h-8 w-44 rounded-md" />

      <Card>
        <CardContent className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-5 w-24 rounded-md" />
          </div>
          <div>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-1 h-5 w-20 rounded-md" />
          </div>
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-36" />
          </div>
          <div>
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-1 h-4 w-16" />
          </div>
          <div className="sm:col-span-2">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-3/4" />
          </div>
          <div>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1 h-4 w-40" />
          </div>
          <div className="flex items-end">
            <Skeleton className="h-8 w-20 rounded-md" />
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <div className="space-y-1">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-full rounded-md" />
          <Skeleton className="h-2.5 w-28" />
        </div>
        <div className="mt-4 overflow-hidden rounded-xl border border-border bg-terminal">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Skeleton className="h-3 w-16" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </div>
          </div>
          <LogLines className="h-120 text-xs">
            <LogLinesSkeleton />
          </LogLines>
        </div>
      </div>
    </div>
  );
}
