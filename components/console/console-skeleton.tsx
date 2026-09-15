import { Skeleton } from "@/components/ui/skeleton";

const LINES = ["w-52", "w-2/3", "w-1/3", "w-44", "w-3/4", "w-1/2", "w-24"];

export function ConsoleSkeleton({ label }: { label: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      role="status"
      aria-busy
      aria-label={label}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Skeleton className="size-4" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-9 w-32 rounded-md" />
        <Skeleton className="h-4 w-16 rounded-full" />
        <Skeleton className="h-9 w-24 rounded-md" />
        <Skeleton className="h-9 w-40 rounded-lg" />
        <div className="ml-auto flex items-center gap-1">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-hidden bg-terminal p-3">
        {LINES.map((w, i) => (
          <Skeleton shimmer key={i} className={`h-4 ${w}`} />
        ))}
      </div>
    </div>
  );
}
