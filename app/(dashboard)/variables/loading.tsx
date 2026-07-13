import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EnvTableSkeleton } from "@/components/env/env-skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading variables" aria-busy>
      {/* PageHeader: "Environment Variables" + long description */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-[30rem]" />
        </div>
      </div>

      {/* UnderlineTabsList: App / Shared (admin-only "All teams" tab omitted) */}
      <div className="flex h-12 items-center gap-1 border-b border-border">
        <div className="px-3">
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="px-3">
          <Skeleton className="h-4 w-16" />
        </div>
      </div>

      {/* App tab body: the <EnvFilters> toolbar, then one collapsible Project
          section per project — each holding the app cards with their editable env
          tables. The toolbar placeholder mirrors the search input (flex-1) + the
          Type and Sort selects; the Author select is skipped because it only
          appears once the rows carry two or more authors. Sections render OPEN by
          default, which is why the skeleton shows their contents. */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-9 min-w-[12rem] flex-1 rounded-md" />
          <Skeleton className="h-9 w-[140px] rounded-md" />
          <Skeleton className="h-9 w-[180px] rounded-md" />
        </div>

        {Array.from({ length: 2 }).map((_, section) => (
          <div key={section} className="space-y-3">
            {/* Project header: chevron + colour tile + name over its counts */}
            <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
              <Skeleton className="size-4 shrink-0 rounded-sm" />
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>

            <div className="space-y-4 sm:pl-4">
              {Array.from({ length: 2 - section }).map((_, card) => (
                <Card key={card}>
                  <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Skeleton className="size-4 shrink-0 rounded-sm" />
                      <Skeleton className="size-8 shrink-0 rounded-md" />
                      <Skeleton className="h-5 w-40" />
                    </div>
                    <div className="flex gap-2">
                      <Skeleton className="h-8 w-16 rounded-md" />
                      <Skeleton className="h-8 w-16 rounded-md" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <EnvTableSkeleton rows={3} className="rounded-lg" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
