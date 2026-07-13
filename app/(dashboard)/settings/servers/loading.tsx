import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading servers"
    >
      {/* PageHeader — "Servers" + description + Check-status / Check-for-updates / Add-server
          actions. The old "Add a server" card is gone (Add is a header action now), so no
          skeleton stands in for it — a placeholder for a card that never arrives is a layout
          shift on every load. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-32 rounded-md" />
          <Skeleton className="h-8 w-40 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>

      {/* Server card grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, card) => (
          <Card key={card}>
            <CardHeader className="space-y-3">
              {/* Name + health chip + access badge, then check-status + actions buttons */}
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-24 rounded-md" />
                <Skeleton className="h-5 w-20 rounded-md" />
                <div className="ml-auto flex items-center gap-1">
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                  <Skeleton className="size-8 shrink-0 rounded-md" />
                </div>
              </div>
              {/* IP + Traefik + agent-version badges */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-5 w-24 rounded-md" />
                <Skeleton className="h-5 w-28 rounded-md" />
              </div>
            </CardHeader>
            <CardContent>
              {/* Four hardware-spec tiles */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, spec) => (
                  <div
                    key={spec}
                    className="rounded-lg border border-border bg-muted/30 p-3"
                  >
                    <div className="flex items-center gap-1.5">
                      <Skeleton className="size-3.5 rounded" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                    <div className="mt-1 flex items-baseline gap-1">
                      <Skeleton className="h-5 w-8" />
                      <Skeleton className="h-3 w-12" />
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
