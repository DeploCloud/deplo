import { Skeleton } from "@/components/ui/skeleton";

// One tuple per placeholder log line: [level-pill width, message width]. Mirrors
// the ContainerLogs stream — a fixed-width uppercase level pill then the message.
const LINES: [string, string][] = [
  ["w-11", "w-3/4"],
  ["w-12", "w-1/2"],
  ["w-14", "w-5/6"],
  ["w-11", "w-2/5"],
  ["w-12", "w-4/5"],
  ["w-11", "w-3/5"],
  ["w-14", "w-11/12"],
  ["w-12", "w-1/2"],
  ["w-11", "w-2/3"],
  ["w-12", "w-7/12"],
  ["w-14", "w-3/4"],
  ["w-11", "w-1/3"],
  ["w-12", "w-5/6"],
  ["w-11", "w-2/5"],
  ["w-14", "w-4/5"],
  ["w-12", "w-1/2"],
  ["w-11", "w-3/5"],
  ["w-12", "w-11/12"],
];

export default function Loading() {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-busy
      aria-label="Loading logs"
    >
      {/* PageHeader (no actions) */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      {/* ContainerLogs panel */}
      <div className="overflow-hidden rounded-xl border border-border">
        {/* Toolbar */}
        <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-20 rounded-full" />
          <div className="ml-auto flex items-center gap-1">
            <Skeleton className="h-5 w-16 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
            <Skeleton className="size-7 rounded-md" />
          </div>
        </div>

        {/* Log stream */}
        <div className="h-[520px] space-y-2 bg-black/90 p-3">
          {LINES.map(([pill, msg], i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton shimmer className={`h-4 shrink-0 rounded ${pill}`} />
              <Skeleton shimmer className={`h-4 ${msg}`} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
