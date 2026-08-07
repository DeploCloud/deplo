import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors `RegistriesPanel`: one card, the Add button in its header, then
 * the configured registries as bordered rows.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading registries"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
          <Skeleton className="h-8 w-32 rounded-md" />
        </CardHeader>
        <CardContent className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{ ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s` }}
                className="h-[4.25rem] w-full rounded-lg"
              />
            ))}
        </CardContent>
      </Card>
    </div>
  );
}
