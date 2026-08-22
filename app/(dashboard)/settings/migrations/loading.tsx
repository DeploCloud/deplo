import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the migrate tab on its first step: the header, the tab bar, then the
 * two columns - the connect form on the left, the illustration on the right.
 * Same 1440px split as the wizard, so the layout does not jump when the real
 * thing arrives.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading Migrations"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-6 border-b border-border pb-3">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-20" />
      </div>

      <div className="mx-auto grid max-w-6xl gap-8 min-[1440px]:grid-cols-[minmax(0,1fr)_22rem] min-[1440px]:gap-10">
        <div className="order-first flex justify-center min-[1440px]:order-last">
          <Skeleton className="h-32 w-52 rounded-xl min-[1440px]:w-full" />
        </div>
        <div className="min-w-0 space-y-6">
          <Skeleton className="h-7 w-72 rounded-md" />
          <Skeleton shimmer className="h-64 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
