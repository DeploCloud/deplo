import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors `UsersPanel`'s always-present card. Its second card only exists
 * when there are pending registration links, and a placeholder for a card
 * that never arrives is a layout shift on every load.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading users"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
          <Skeleton className="h-8 w-28 rounded-md" />
        </CardHeader>
        <CardContent className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              shimmer
              style={{
                ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s`,
              }}
              className="h-[4.25rem] w-full rounded-lg"
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
