import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors `RegistriesPanel`: the header with its Add button, then the card grid —
 * the same fallback the Git settings page uses, because it is now the same page
 * shape.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading registries"
    >
      {/* PageHeader, with the Add registry button on its right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton
            key={i}
            shimmer
            style={{
              ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s`,
            }}
            className="h-[5.5rem] w-full rounded-xl"
          />
        ))}
      </div>
    </div>
  );
}
