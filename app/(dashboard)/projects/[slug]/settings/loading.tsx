import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      {Array.from({ length: 3 }).map((_, card) => (
        <div key={card} className="rounded-xl border border-border p-6">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="mt-6 space-y-5">
            {Array.from({ length: 3 }).map((_, row) => (
              <div key={row} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-9 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center justify-end">
        <Skeleton className="h-9 w-28" />
      </div>
    </div>
  );
}
