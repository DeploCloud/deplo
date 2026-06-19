import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="flex items-center gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-24" />
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-4 border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-20 flex-1" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="flex flex-1 items-center gap-3">
              <Skeleton className="size-8 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
            <Skeleton className="h-5 w-16 flex-1 rounded-md" />
            <Skeleton className="h-4 w-20 flex-1" />
            <Skeleton className="ml-auto size-8 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
