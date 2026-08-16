import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the page: header, the tab bar, then the one card the Connect tab
 * opens on. Deliberately ONE card and not a stack — the page no longer is one,
 * and a skeleton that draws more than arrives makes the load feel like a stall
 * at the moment the real thing appears.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading MCP settings"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-5 w-12 rounded-md" />
        </div>
        <Skeleton className="h-4 w-96" />
      </div>

      {/* The tab bar: two triggers on the left, the tool link on the right. */}
      <div className="flex items-center justify-between border-b border-border pb-3">
        <div className="flex gap-6">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-4 w-56" />
      </div>

      {/* Connect: the stepper, then the wizard's first step. */}
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
