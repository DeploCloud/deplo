import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the migrate tab on its first step: the header, the tab bar, then the
 * two columns - the connect form on the left, the illustration on the right.
 * Two columns only from `xl`, exactly like the wizard, so the layout does not
 * jump when the real thing arrives.
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

      <div className="mx-auto grid max-w-5xl gap-8 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-12">
        <div className="order-first flex justify-center xl:order-last">
          <Skeleton className="h-32 w-52 rounded-xl xl:w-full" />
        </div>
        <div className="min-w-0 space-y-6">
          <Skeleton className="h-7 w-72 rounded-md" />
          <Skeleton shimmer className="h-64 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
