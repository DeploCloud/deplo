// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@/components/ui/skeleton";
import {
  StoreChipsSkeleton,
  StoreRailsSkeleton,
} from "@/components/templates/store-skeleton";

/** Mirrors the store's real layout: the search band, the chip row and two rails.
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
      <div className="deplo-grid-bg rounded-xl border border-border px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto flex max-w-2xl flex-col items-center">
          <Skeleton className="h-8 w-40" shimmer />
          <Skeleton className="mt-2 h-4 w-72" shimmer />
          <Skeleton className="mt-5 h-10 w-full" shimmer />
        </div>
      </div>

      <StoreChipsSkeleton />
      <StoreRailsSkeleton />
    </div>
  );
}
