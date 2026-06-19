import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      {/* Production hero */}
      <div className="rounded-xl border border-border">
        <div className="flex items-center justify-between p-6">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-5 w-20 rounded-md" />
        </div>
        <div className="p-6 pt-0">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-4 w-40" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-4 w-24" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-4 w-44" />
              </div>
              <div className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-16" />
              </div>
              <div className="flex gap-2 pt-1">
                <Skeleton className="h-8 w-28 rounded-md" />
                <Skeleton className="h-8 w-20 rounded-md" />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Deployments */}
      <div className="space-y-3">
        <Skeleton className="h-6 w-36" />
        <div className="overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-0"
            >
              <Skeleton className="size-2.5 rounded-full" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="hidden h-5 w-20 rounded-md sm:block" />
              <Skeleton className="hidden h-3 w-12 sm:block" />
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
