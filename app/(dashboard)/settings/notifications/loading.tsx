import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors the notifications page, INCLUDING its second column. The old
 * fallback had one column, so the page jumped sideways the moment it
 * arrived; the 260px aside is reserved here even though the illustration
 * inside it is decoration.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading notification channels"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="size-3.5 rounded-full" />
              </div>
          <Skeleton className="h-8 w-32 rounded-md" />
            </CardHeader>
            <CardContent className="space-y-2">
                {Array.from({ length: 5 }).map((_, i) => (
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
        <aside className="hidden xl:block">
          <Skeleton className="mx-auto h-[22rem] w-full max-w-[260px] rounded-[2rem]" />
        </aside>
      </div>
    </div>
  );
}
