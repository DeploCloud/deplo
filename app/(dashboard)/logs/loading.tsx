import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-4 w-96" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="size-2.5 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="h-96 space-y-2 px-4 py-3">
            {[
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
            ].map((width, i) => (
              <div key={i} className="flex items-center gap-3">
                <Skeleton className="h-3 w-20 shrink-0" />
                <Skeleton className={`h-3 ${width}`} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
