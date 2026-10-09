import type { CSSProperties } from "react";

import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { COLLECTIONS, FEATURED } from "@/components/templates/collections";
import { cn } from "@/lib/utils";

const delay = (ms: number) =>
  ({ "--shimmer-delay": `${ms}ms` }) as CSSProperties;

// All, four categories and More, measured; pb-1 is CategoryChips' focus gutter.
const CHIP_WIDTHS = ["w-15", "w-29", "w-14", "w-30", "w-20", "w-19"];

export function StoreChipsSkeleton() {
  return (
    <div className="-mx-1 flex gap-2 overflow-hidden px-1 pb-1">
      {CHIP_WIDTHS.map((width, i) => (
        <Skeleton
          key={i}
          className={cn("h-8 shrink-0 rounded-full", width)}
          shimmer
          style={delay(i * 40)}
        />
      ))}
    </div>
  );
}

export function StoreRailsSkeleton() {
  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <TextLine shimmer type={titleClass.section} className="w-24" />
        <div className="grid gap-3 xl:grid-cols-3">
          <HeroCardSkeleton />
          <div className="grid gap-3 sm:grid-cols-2 xl:col-span-2">
            {FEATURED.slice(1).map((slug, i) => (
              <SidekickSkeleton key={slug} style={delay((i + 1) * 60)} />
            ))}
          </div>
        </div>
      </section>

      {COLLECTIONS.slice(0, 2).map((collection) => (
        <section key={collection.title} className="space-y-3">
          <div>
            <TextLine shimmer type={titleClass.section} className="w-44" />
            <TextLine
              shimmer
              type="mt-1 text-sm leading-[1.6]"
              className="w-80 max-w-full"
            />
          </div>
          <div className="-mx-1 flex gap-3 overflow-hidden px-1 py-1">
            {Array.from({ length: 6 }, (_, i) => (
              <CardSkeleton
                key={i}
                className="w-72 shrink-0"
                style={delay(i * 60)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function HeroCardSkeleton() {
  return (
    <div className="flex flex-col justify-between gap-5 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-col gap-4">
        <Skeleton className="size-20 rounded-2xl" shimmer />
        {/* The featured description fits one line from ~31rem. */}
        <div className="@container">
          <TextLine shimmer type="text-xl" className="w-40" />
          <Description type="text-sm" last="@min-[31rem]:hidden" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-24" shimmer />
        <Skeleton className="h-9 w-32" shimmer />
      </div>
    </div>
  );
}

function SidekickSkeleton({ style }: { style: CSSProperties }) {
  return (
    <div
      style={style}
      className="flex items-center gap-4 rounded-xl border border-border bg-card p-4"
    >
      <Skeleton className="size-12 rounded-xl" shimmer />
      <div className="min-w-0 flex-1">
        <TextLine shimmer type="text-sm" className="w-28" />
        <Description type="text-xs" />
      </div>
    </div>
  );
}

function CardSkeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        "flex flex-col gap-3 rounded-xl border border-border bg-card p-4",
        className,
      )}
    >
      <Skeleton className="size-14 rounded-xl" shimmer />
      <div>
        <TextLine shimmer type="text-sm" className="w-24" />
        <Description type="text-xs" />
      </div>
    </div>
  );
}

// The cards clamp their description to two lines, and most fill both.
function Description({ type, last }: { type: string; last?: string }) {
  return (
    <div className={`mt-1 leading-relaxed ${type}`}>
      <TextLine shimmer className="w-full" />
      <TextLine shimmer type={last} className="w-2/3" />
    </div>
  );
}
