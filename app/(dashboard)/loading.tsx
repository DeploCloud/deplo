import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      {/* Right rail */}
      <div className="order-2 space-y-6 lg:order-2">
        {/* Recent activity */}
        <div className="rounded-xl border border-border">
          <div className="p-6 pb-3">
            <Skeleton className="h-5 w-32" />
          </div>
          <div className="space-y-4 px-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="size-5 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
            ))}
          </div>
          <div className="p-6 pt-4">
            <Skeleton className="h-8 w-full rounded-md" />
          </div>
        </div>

        {/* Recent Previews */}
        <div className="rounded-xl border border-border">
          <div className="p-6 pb-3">
            <Skeleton className="h-5 w-36" />
          </div>
          <div className="p-6 pt-0">
            <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-6">
              <Skeleton className="size-8 rounded-md" />
              <Skeleton className="h-3.5 w-40" />
            </div>
          </div>
        </div>
      </div>

      {/* Left main */}
      <div className="order-1 space-y-5 lg:order-1">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <Skeleton className="h-9 w-full rounded-md" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="size-10 rounded-md" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
              <div className="mt-4 flex items-center justify-between">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
