import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * The store's placeholders. One file because two moments render them, and a
 * skeleton showing a different shape makes the page jump on arrival.
 */

/** The chip row above the rails. */
export function StoreChipsSkeleton() {
  return (
    <div className="flex gap-2 overflow-hidden">
      {Array.from({ length: 9 }).map((_, i) => (
        <Skeleton
          key={i}
          className="h-8 w-24 shrink-0 rounded-full"
          shimmer
          style={{ "--shimmer-delay": `${i * 40}ms` } as CSSProperties}
        />
      ))}
    </div>
  );
}

/** The storefront plus two rails: the head of the store, and enough of it to
 *  fill a screen. */
export function StoreRailsSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" shimmer />
        <div className="grid gap-3">
          <Skeleton className="h-[6.5rem] rounded-xl" shimmer />
          <Skeleton className="h-[6.5rem] rounded-xl" shimmer />
        </div>
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
                style={{ "--shimmer-delay": `${i * 60}ms` } as CSSProperties}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
