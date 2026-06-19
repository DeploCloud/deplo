import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
        <div className="max-h-96 space-y-3 px-4 py-4">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
          <Skeleton className="h-3 w-4/5" />
        </div>
      </div>
    </div>
  );
}
