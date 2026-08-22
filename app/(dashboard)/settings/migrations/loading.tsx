import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the migrate tab on its first step: the header, the tab bar, then the
 * illustration on top and the connect form under it. Same single centred column
 * as the wizard, so the layout does not jump when the real thing arrives.
 */
export default function Loading() {
  return (
    <div
      className="space-y-8"
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
      <div className="flex gap-6 border-b border-border pb-3 pt-2">
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-20" />
      </div>

      <div className="mx-auto flex w-full flex-col items-center gap-8 pt-4">
        <Skeleton className="h-56 w-full max-w-md rounded-xl" />
        <div className="w-full max-w-xl space-y-6">
          <Skeleton className="h-7 w-72 rounded-md" />
          <Skeleton shimmer className="h-64 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
