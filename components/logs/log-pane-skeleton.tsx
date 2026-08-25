import { Skeleton } from "@/components/ui/skeleton";

// One tuple per placeholder log line: [level-gutter width, message width].
// Mirrors the ContainerLogs stream: a fixed-width level gutter (a chip only
// where the level is not info) and then the message.
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

/**
 * The loading frame every log route shares: one toolbar row and the stream
 * below it, at the size the real pane will be.
 *
 * One file because the three routes render one pane. The App's and the
 * database's copies of this were byte-identical, and the general Logs page
 * would have made a third — `loading.tsx` cannot read searchParams, so it
 * cannot tell the chooser from the pane and shows the pane either way. The
 * pane is both the steady state and the slow one (`getLogsInfo` dials the
 * agent), so that is the right guess.
 */
export function LogPaneSkeleton() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      role="status"
      aria-busy
      aria-label="Loading logs"
    >
      {/* Toolbar: container picker, status, search, level filter, actions. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <Skeleton className="size-4" />
        {/* The name, which is the only heading this route has. */}
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-36 rounded-md" />
        <Skeleton className="h-4 w-20 rounded-full" />
        <Skeleton className="h-9 w-full max-w-100 rounded-md" />
        <Skeleton className="h-9 w-36 rounded-md" />
        <div className="ml-auto flex items-center gap-1">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
        </div>
      </div>

      {/* Log stream, filling the frame the way the pane itself does. */}
      <div className="min-h-0 flex-1 space-y-2 overflow-hidden bg-black/90 p-3">
        {LINES.map(([pill, msg], i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton shimmer className={`h-4 shrink-0 rounded ${pill}`} />
            <Skeleton shimmer className={`h-4 ${msg}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
