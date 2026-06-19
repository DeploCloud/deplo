import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
          {[
            "h-8 w-20",
            "h-8 w-24",
            "h-8 w-16",
            "h-8 w-28",
            "h-8 w-32",
            "h-8 w-24",
            "h-8 w-16",
          ].map((cls, i) => (
            <Skeleton key={i} className={cls} />
          ))}
        </div>
        <div className="mt-4 space-y-4">
          <div className="rounded-xl border border-border">
            <div className="space-y-2 p-6">
              <Skeleton className="h-5 w-24" />
              <Skeleton className="h-4 w-72" />
            </div>
            <div className="space-y-5 p-6 pt-0">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-border">
            <div className="space-y-2 p-6">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-64" />
            </div>
            <div className="p-6 pt-0">
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-6 w-11 rounded-full" />
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-border p-6">
            <div className="space-y-2">
              <Skeleton className="h-5 w-36" />
              <Skeleton className="h-4 w-80" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
