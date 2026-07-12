import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading apps"
    >
      {/* PageHeader — "Apps" + description */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-4 w-[34rem]" />
        </div>
      </div>

      {/* PluginsBrowser — two stacked sections (Installed, Catalog) */}
      <div className="space-y-8">
        {/* Installed */}
        <section className="space-y-4">
          <div className="space-y-1">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-56" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="size-11 rounded-lg" />
                  <Skeleton className="h-5 w-16 rounded-md" />
                </div>
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <div className="flex gap-2">
                  <Skeleton className="h-8 w-20 rounded-md" />
                  <Skeleton className="ml-auto h-8 w-20 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Catalog */}
        <section className="space-y-4">
          <div className="space-y-1">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-3 w-56" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2 3xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="size-11 rounded-lg" />
                  <Skeleton className="h-5 w-14 rounded" />
                </div>
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-full" />
                  <Skeleton className="h-3 w-3/4" />
                </div>
                <Skeleton className="mt-1 h-8 w-full rounded-md" />
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
