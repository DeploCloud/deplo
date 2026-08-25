import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors `GitPanel`: the header, then the card grid. Two cards stand in - most
 * instances have one or two connected hosts, and drawing an empty state instead
 * would say "nothing is coming", which is a lie half the time.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading Git settings"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-12" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton
            key={i}
            shimmer
            style={{
              ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s`,
            }}
            className="h-[7.5rem] w-full rounded-xl"
          />
        ))}
      </div>
    </div>
  );
}
