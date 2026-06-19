import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="flex items-center gap-6 border-b border-border">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>

      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="rounded-xl border border-border">
            <div className="flex items-center justify-between p-6">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-8 w-24" />
            </div>
            <div className="p-6 pt-0">
              <div className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-4 border-b px-4 py-3">
                  <Skeleton className="h-4 w-16 flex-1" />
                  <Skeleton className="h-4 w-16 flex-1" />
                  <Skeleton className="h-4 w-24 flex-1" />
                </div>
                {Array.from({ length: 3 }).map((_, row) => (
                  <div
                    key={row}
                    className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
                  >
                    <Skeleton className="h-4 w-32 flex-1" />
                    <Skeleton className="h-4 w-40 flex-1" />
                    <div className="flex flex-1 items-center gap-1">
                      <Skeleton className="h-4 w-14 rounded-full" />
                      <Skeleton className="h-4 w-14 rounded-full" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
