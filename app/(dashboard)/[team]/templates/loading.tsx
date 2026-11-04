"use client";

import {
  StoreChipsSkeleton,
  StoreRailsSkeleton,
} from "@/components/templates/store-skeleton";
import { StoreHero } from "@/components/templates/template-store";

export default function Loading() {
  return (
    <div className="space-y-8" aria-busy>
      <StoreHero loading count={120} query="" onQuery={() => {}} canDeploy />
      <StoreChipsSkeleton />
      <StoreRailsSkeleton />
    </div>
  );
}
