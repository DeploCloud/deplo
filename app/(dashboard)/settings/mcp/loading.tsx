import { Skeleton } from "@/components/ui/skeleton";

/**
 * Mirrors the page: header, the two-switch card, the connect card, then the
 * tool table. The table stands in with rows rather than an empty block — it is
 * always long, and a fallback that draws "almost nothing is coming" is a lie.
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

      {/* Access: two switch rows. */}
      <Skeleton className="h-48 w-full rounded-xl" />
      {/* Connect an agent: client picker + snippet. */}
      <Skeleton className="h-52 w-full rounded-xl" />

      <div className="space-y-2 rounded-xl border border-border p-6">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-4 w-80" />
        <div className="space-y-2 pt-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
