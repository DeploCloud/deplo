import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors `ImportWizard` on its first step: the header, the step rail, then the
 * connect card. One card, because that is all the first step ever shows.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading Import settings"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      {/* Step rail */}
      <Skeleton className="h-7 w-72 rounded-md" />

      <Skeleton shimmer className="h-64 w-full rounded-xl" />
    </div>
  );
}
