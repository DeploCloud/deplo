import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the notifications page, INCLUDING its second column.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading notification channels"
    >
      {/* PageHeader, with the Add channel button on its right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-3">
          {/* The heading row: icon, label, info tip, then the "N on" count. */}
          <div className="flex items-center gap-1.5 px-1">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-5 w-12 rounded-md" />
          </div>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{
                  ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s`,
                }}
                className="h-[4.25rem] w-full rounded-xl"
              />
            ))}
          </div>
        </div>
        <aside className="hidden xl:block">
          <Skeleton className="mx-auto h-[22rem] w-full max-w-[260px] rounded-[2rem]" />
        </aside>
      </div>
    </div>
  );
}
