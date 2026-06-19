import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Skeleton className="h-7 w-28" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="rounded-xl border border-border">
        <div className="space-y-8 p-6">
          {Array.from({ length: 2 }).map((_, group) => (
            <div key={group} className="space-y-4">
              <Skeleton className="h-3 w-24" />
              <ol className="relative space-y-5 pl-2">
                <span className="absolute left-4 top-2 bottom-2 w-px bg-border" />
                {Array.from({ length: 4 }).map((_, i) => (
                  <li key={i} className="flex items-start gap-4">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-2 pt-1">
                      <Skeleton className="h-4 w-64" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
