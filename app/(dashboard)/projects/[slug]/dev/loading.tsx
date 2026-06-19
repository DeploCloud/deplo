import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      {/* Dev Mode — enable toggle + container lifecycle */}
      <div className="rounded-xl border border-border p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-6 w-11 rounded-full" />
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

      {/* Underline tabs bar */}
      <div className="flex items-center gap-6 border-b border-border pb-1">
        {Array.from({ length: 3 }).map((_, tab) => (
          <Skeleton key={tab} className="h-4 w-20" />
        ))}
      </div>

      {/* Content card — SSH users table */}
      <div className="rounded-xl border border-border p-6">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="mt-6 space-y-3">
          {/* Header row */}
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-24 flex-1" />
            <Skeleton className="h-4 w-24 flex-1" />
            <Skeleton className="h-4 w-24 flex-1" />
          </div>
          {/* Body rows */}
          {Array.from({ length: 2 }).map((_, row) => (
            <div key={row} className="flex items-center gap-4">
              <Skeleton className="h-4 w-32 flex-1" />
              <Skeleton className="h-4 w-20 flex-1" />
              <Skeleton className="h-4 w-40 flex-1" />
            </div>
          ))}
        </div>
        <div className="mt-6 flex items-center justify-end">
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
    </div>
  );
}
