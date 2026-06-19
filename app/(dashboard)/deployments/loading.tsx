import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-4 border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-24 flex-1" />
          <Skeleton className="h-4 w-20 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="h-4 w-10" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-4 w-28 flex-1" />
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="h-5 w-20 rounded-md" />
            <div className="flex flex-1 items-center gap-1.5">
              <Skeleton className="size-3.5 rounded-sm" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="ml-auto size-8 rounded-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
