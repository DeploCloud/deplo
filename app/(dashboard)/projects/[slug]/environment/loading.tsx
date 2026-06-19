import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-72" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-9 w-1/3" />
              <Skeleton className="h-9 flex-1" />
              <Skeleton className="ml-auto h-8 w-8 rounded-md" />
            </div>
          ))}
        </div>
      </section>
      <section className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-9 w-1/3" />
              <Skeleton className="h-9 flex-1" />
              <Skeleton className="ml-auto h-8 w-8 rounded-md" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
