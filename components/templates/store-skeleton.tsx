import type { CSSProperties } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * The store's placeholders, in one file because two different moments render
 * them: `templates/loading.tsx` (the whole page, before the RSC read lands) and
 * `template-store.tsx` (the rails alone, while the logo accents stream in).
 *
 * They have to move with `template-store.tsx` - a skeleton that shows a
 * different shape makes the page jump on arrival - and keeping one copy is what
 * stops the two callers from drifting apart.
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

/** Two category rails: the head of the store, and enough of it to fill a screen. */
export function StoreRailsSkeleton() {
  return (
    <div className="space-y-8">
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
