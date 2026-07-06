import { Skeleton } from "@/components/ui/skeleton";

const LEVEL_CHIP_WIDTHS = ["w-20", "w-12", "w-14", "w-14", "w-16", "w-16"];

const LOG_LINES = [
  "w-3/4",
  "w-1/2",
  "w-2/3",
  "w-5/6",
  "w-2/5",
  "w-4/5",
  "w-1/2",
  "w-3/5",
  "w-11/12",
  "w-1/3",
  "w-3/4",
  "w-2/3",
  "w-1/2",
  "w-5/6",
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading logs"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      {/* LogViewer */}
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {/* Deployment list */}
        <div className="rounded-xl border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <Skeleton className="h-3 w-32" />
          </div>
          <div className="divide-y divide-border">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-1.5 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-2.5 shrink-0 rounded-full" />
                  <Skeleton className="h-4 w-28" />
                </div>
                <Skeleton className="h-3 w-40" />
                <div className="flex items-center gap-1.5">
                  <Skeleton className="h-2.5 w-16" />
                  <Skeleton className="h-2.5 w-10" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Log panel */}
        <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card">
          {/* Toolbar */}
          <div className="flex flex-col gap-3 border-b border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
              <Skeleton className="h-8 w-28 rounded-md" />
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              {LEVEL_CHIP_WIDTHS.map((width, i) => (
                <Skeleton key={i} className={`h-7 rounded-md ${width}`} />
              ))}
            </div>
          </div>

          {/* Terminal */}
          <div className="max-h-[540px] space-y-1 rounded-b-xl bg-[#0a0a0a] p-4">
            {LOG_LINES.map((width, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton shimmer className="h-3 w-16 shrink-0" />
                <Skeleton shimmer className="h-5 w-10 shrink-0 rounded" />
                <Skeleton shimmer className={`h-3 ${width}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
