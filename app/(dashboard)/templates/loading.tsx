import { Skeleton } from "@/components/ui/skeleton";

/** Mirrors the store's real layout: the search band, the chip row, two rails
 *  and the head of the grid. It has to move with `template-store.tsx` — a
 *  skeleton that shows a different shape makes the page jump on arrival. */
export default function Loading() {
  return (
    <div className="space-y-8" role="status" aria-busy aria-label="Loading templates">
      <div className="deplo-grid-bg rounded-xl border border-border px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto flex max-w-2xl flex-col items-center">
          <Skeleton className="h-8 w-40" shimmer />
          <Skeleton className="mt-2 h-4 w-72" shimmer />
          <Skeleton className="mt-5 h-10 w-full" shimmer />
        </div>
      </div>

      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-8 w-24 shrink-0 rounded-full"
            shimmer
            style={{ "--shimmer-delay": `${i * 40}ms` } as React.CSSProperties}
          />
        ))}
      </div>

      {Array.from({ length: 2 }).map((_, row) => (
        <div key={row} className="space-y-3">
          <Skeleton className="h-5 w-44" shimmer />
          <div className="flex gap-3 overflow-hidden">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton
                key={i}
                className="h-36 w-56 shrink-0 rounded-xl"
                shimmer
                style={{ "--shimmer-delay": `${i * 60}ms` } as React.CSSProperties}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
