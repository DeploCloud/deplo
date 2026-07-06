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
      {/* PageHeader — "Servers" + description + Check-for-updates action */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-40 rounded-md" />
        </div>
      </div>

      {/* "Add a server" card — title + description on the left, AddServer button right */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-5 w-28" />
            <div className="space-y-1.5">
              <Skeleton className="h-4 w-full max-w-[34rem]" />
              <Skeleton className="h-4 w-full max-w-[30rem]" />
              <Skeleton className="h-4 w-2/3 max-w-[16rem]" />
            </div>
          </div>
          <Skeleton className="h-8 w-40 rounded-md" />
        </CardHeader>
      </Card>

      {/* Server card grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, card) => (
          <Card key={card}>
            <CardHeader className="space-y-3">
              {/* Status dot + name + status/access badges + actions menu */}
              <div className="flex items-center gap-2">
                <Skeleton className="size-2.5 rounded-full" />
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-16 rounded-md" />
                <Skeleton className="h-5 w-20 rounded-md" />
                <Skeleton className="ml-auto size-8 shrink-0 rounded-md" />
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
