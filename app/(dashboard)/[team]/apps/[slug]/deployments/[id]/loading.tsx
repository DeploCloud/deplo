import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";

const ROW = "flex items-center gap-3 px-5 py-4";

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading deployment"
    >
      <Skeleton className="-ml-2 h-8 w-44 rounded-md" />

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <div className="grid gap-x-6 gap-y-5 p-5 sm:grid-cols-2 xl:grid-cols-4">
          {["w-28", "w-16", "w-14", "w-24"].map((w) => (
            <div key={w}>
              <Skeleton className="h-3 w-16" />
              <Skeleton className={`mt-1.5 h-5 ${w}`} />
            </div>
          ))}
          <div className="sm:col-span-2 xl:col-span-4">
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-1.5 h-4 w-20" />
            <Skeleton className="mt-1.5 h-4 w-2/3" />
          </div>
        </div>
        <div className={`${ROW} border-t border-border`}>
          <Skeleton className="h-4 w-40" />
        </div>
      </Card>

      <Card className="divide-y divide-border overflow-hidden">
        {["w-24", "w-40", "w-20"].map((w) => (
          <div key={w} className={ROW}>
            <Skeleton className={`h-4 ${w}`} />
          </div>
        ))}
      </Card>
    </div>
  );
}
