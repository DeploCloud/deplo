import { Skeleton } from "@/components/ui/skeleton";

/**
 * Roles is the one settings section with a layout of its own: a rail of the
 * team's roles on the left and whichever one is open on the right. Its skeleton
 * has to be that shape, not the index's - drawing a stack of form cards here
 * would move the whole page sideways the moment the real thing arrives.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading roles"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(220px,260px)_1fr]">
        {/* The rail: its own small heading, the New role button, then the roles.
            Four rows because every team has at least the three built-ins. */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-8 w-24 rounded-md" />
          </div>
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{ ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s` }}
                className="h-14 w-full rounded-lg"
              />
            ))}
          </div>
        </div>

        {/* The open role: its header, then the permission picker's own card. */}
        <div className="min-w-0 space-y-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
