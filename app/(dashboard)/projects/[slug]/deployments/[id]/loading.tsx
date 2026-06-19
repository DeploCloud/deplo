import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-32" />

      <div className="rounded-xl border border-border">
        <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-5 w-28" />
            </div>
          ))}
          <div className="space-y-2 sm:col-span-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-full max-w-md" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-36" />
          </div>
          <div className="flex items-end">
            <Skeleton className="h-8 w-24" />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <Skeleton className="h-5 w-24" />
        <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-6 w-20" />
          </div>
          <div className="max-h-120 space-y-2 p-4">
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="h-3 w-16 shrink-0" />
                <Skeleton className="h-3 w-full max-w-lg" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
