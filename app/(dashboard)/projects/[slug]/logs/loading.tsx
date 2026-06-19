import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-24" />
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
  );
}
