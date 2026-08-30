import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// The grid below mirrors AppsGrid's own breakpoints (1 col, 2 from `sm`, 3 from
// `3xl`), so the placeholder count has to follow them too: a fixed count leaves a
// half-empty last row on the wider layouts.
const ROW_FILL = [
  "",
  "",
  "hidden sm:flex",
  "hidden sm:flex",
  "hidden 3xl:flex",
  "hidden 3xl:flex",
];

export default function Loading() {
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]"
      role="status"
      aria-busy
      aria-label="Loading dashboard"
    >
      {/* Right rail */}
      <div className="order-2 space-y-6 lg:order-2">
        {/* Recent activity */}
        <Card>
          <CardHeader className="pb-3">
            <Skeleton className="h-4 w-28" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-start gap-2.5">
                <Skeleton className="mt-0.5 size-5 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-full" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            ))}
            <Skeleton className="h-8 w-full rounded-md" />
          </CardContent>
        </Card>
      </div>

      {/* Apps */}
      <div className="order-1 space-y-5 lg:order-1">
        {/* Header row: title + Add New */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>

        {/* Search + view toggles */}
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 flex-1 rounded-md" />
          <Skeleton className="hidden size-9 rounded-md sm:block" />
          <Skeleton className="hidden size-9 rounded-md sm:block" />
        </div>

        {/* Apps grid */}
        <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
          {ROW_FILL.map((fill, i) => (
            <Card key={i} className={cn("flex flex-col gap-4 p-5", fill)}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <Skeleton className="size-9 rounded-md" />
                  <div className="min-w-0 space-y-1.5">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
                <Skeleton className="size-8 rounded-md" />
              </div>
              {/* Latest deployment box */}
              <div className="rounded-lg border border-border bg-secondary/40 p-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-1.5 rounded-full" />
                  <Skeleton className="h-3.5 w-14" />
                  <Skeleton className="h-3.5 flex-1" />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
