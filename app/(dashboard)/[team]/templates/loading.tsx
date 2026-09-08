import { Skeleton } from "@/components/ui/skeleton";
import {
  StoreChipsSkeleton,
  StoreRailsSkeleton,
} from "@/components/templates/store-skeleton";

/** Mirrors the store's real layout: the search header, the chip row and the rails.
 *  The chips and rails come from `store-skeleton.tsx`, which the store itself
 *  renders while its logo accents stream - one shape, one place to change it. */
export default function Loading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-busy
      aria-label="Loading templates"
    >
      <div className="mx-auto flex max-w-2xl flex-col items-center pt-8 sm:pt-12">
        <Skeleton className="h-9 w-44" shimmer />
        <Skeleton className="mt-2 h-4 w-72" shimmer />
        <Skeleton className="mt-5 h-10 w-full max-w-md" shimmer />
      </div>

      <StoreChipsSkeleton />
      <StoreRailsSkeleton />
    </div>
  );
}
