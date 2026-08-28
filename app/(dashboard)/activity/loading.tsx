import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// One width per placeholder row's message. The actor line above it is a fixed
// width, because a name is always about as long as the next one.
const ROWS = ["w-64", "w-80", "w-56", "w-72", "w-48", "w-64", "w-40"];

export default function Loading() {
  return (
    <div role="status" aria-busy aria-label="Loading activity">
      <div className="flex gap-2 py-3">
        {["flex-1", "w-40", "flex-1", "flex-1"].map((w, i) => (
          <Skeleton key={i} className={cn("h-9 rounded-md", w)} />
        ))}
      </div>
      <ol className="relative space-y-6">
        <span
          aria-hidden
          className="absolute inset-y-0 left-4 w-px -translate-x-1/2 bg-border"
        />
        <li className="py-2">
          <Skeleton className="h-3 w-40" />
        </li>
        {ROWS.map((width, i) => (
          <li key={i} className="relative flex items-start gap-3">
            <Skeleton className="relative z-10 size-8 shrink-0 rounded-full ring-4 ring-background" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className={cn("h-4", width)} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
