import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-36" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 3 }).map((_, card) => (
          <div
            key={card}
            className="space-y-4 rounded-xl border border-border p-6"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-2.5 rounded-full" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="ml-auto h-5 w-16 rounded-full" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, stat) => (
                <div key={stat} className="space-y-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
            <Skeleton className="h-32 w-full rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
