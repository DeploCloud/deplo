import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading monitoring"
    >
      {/* Host name + live status line, and the chart window selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-56 rounded-lg" />
      </div>

      {/* Gauges, then the network reading */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center gap-3 p-4">
              <Skeleton className="size-[92px] rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-3 w-12" />
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-3 w-24" />
              </div>
            </CardContent>
          </Card>
        ))}
        <Card>
          <CardContent className="space-y-1.5 p-4">
            <div className="flex items-center gap-1.5">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-3 w-16" />
            </div>
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-4 w-20" />
          </CardContent>
        </Card>
      </div>

      {/* The 2x2 chart grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-32" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-[200px] w-full rounded-lg" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* The fleet, under this host's numbers. Drawn at three rows: a single-server
          instance renders none, and guessing low reads as a jump when the real one lands. */}
      <Card>
        <CardContent className="p-0">
          <div className="flex items-center gap-3 border-b px-4 py-2">
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <Skeleton className="size-2.5 rounded-full" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
                <Skeleton className="hidden h-[22px] w-[72px] sm:block" />
                {Array.from({ length: 3 }).map((_, j) => (
                  <Skeleton key={j} className="h-4 w-9" />
                ))}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Info strip */}
      <Card>
        <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-3.5 rounded" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-4 w-20" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
