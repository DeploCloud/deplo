import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      {/* PageHeader */}
      <div className="space-y-1">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Underline-tabs bar */}
      <div className="flex items-center gap-6 border-b border-border">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 pb-2">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-5 w-6 rounded-full" />
          </div>
        ))}
      </div>

      {/* Databases tab */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border p-5">
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
            <div className="mt-4 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="mt-5 flex items-center justify-between">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-20 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
