import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors `GithubPanel`: one card. Most instances have zero or one
 * connected app, so one row stands in - drawing an empty state instead
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
          <Skeleton className="h-8 w-12" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
            {Array.from({ length: 1 }).map((_, i) => (
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
