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
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      {/* MonitoringDashboard (default: server online, live metrics) */}
      <div className="space-y-6">
        {/* Server selector */}
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
            >
              <Skeleton className="size-2.5 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-5 w-14 rounded-md" />
              <Skeleton className="hidden h-3 w-24 sm:block" />
            </div>
          ))}
        </div>

        {/* Live status line */}
        <div className="flex items-center gap-2">
          <Skeleton className="size-2 rounded-full" />
          <Skeleton className="h-3 w-40" />
        </div>

        {/* Current-value tiles */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-center gap-1.5">
                  <Skeleton className="size-4 rounded" />
                  <Skeleton className="h-3 w-12" />
                </div>
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-1.5 w-full rounded-full" />
                <Skeleton className="h-3 w-28" />
              </CardContent>
            </Card>
          ))}
          {/* Network tile */}
          <Card>
            <CardContent className="space-y-1.5 p-4">
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3 w-16" />
              </div>
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-5 w-24" />
              </div>
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Real-time charts */}
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-32 w-full rounded-lg" />
              </CardContent>
            </Card>
          ))}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-40" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-32 w-full rounded-lg" />
            </CardContent>
          </Card>
        </div>

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
    </div>
  );
}
