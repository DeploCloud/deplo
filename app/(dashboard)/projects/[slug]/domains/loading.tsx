import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-4 border-b px-4 py-3">
          <Skeleton className="h-4 w-24 flex-1" />
          <Skeleton className="h-4 w-24 flex-1" />
          <Skeleton className="h-4 w-16 flex-1" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-4 w-40 flex-1" />
            <Skeleton className="h-4 w-28 flex-1" />
            <Skeleton className="h-5 w-16 flex-1 rounded-full" />
            <div className="ml-auto flex items-center justify-end gap-2">
              <Skeleton className="h-8 w-8 rounded-md" />
              <Skeleton className="h-8 w-8 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
