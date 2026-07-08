import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading templates"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-[30rem] max-w-full" />
        </div>
      </div>

      {/* TemplatesBrowser */}
      <div className="space-y-5">
        {/* Filter dropdown + search bar row (count rides inside the search bar) */}
        <div className="flex items-center gap-2">
          <Skeleton className="h-10 w-44 shrink-0 rounded-md" />
          <Skeleton className="h-10 flex-1 rounded-md" />
        </div>

        {/* Card grid — 3×4 (12 cards) so the loading state fills the viewport
            like the real, populated template grid instead of a sparse 2 rows. */}
        <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div
              key={i}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <Skeleton className="size-11 rounded-lg" />
                <Skeleton className="h-5 w-16 rounded-md" />
              </div>

              <div className="flex-1">
                <Skeleton className="h-4 w-24" />
                <div className="mt-2 space-y-1.5">
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
              </div>

              <div className="flex flex-wrap gap-1">
                <Skeleton className="h-4 w-10 rounded" />
                <Skeleton className="h-4 w-12 rounded" />
                <Skeleton className="h-4 w-10 rounded" />
              </div>

              <Skeleton className="mt-1 h-8 w-full rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
