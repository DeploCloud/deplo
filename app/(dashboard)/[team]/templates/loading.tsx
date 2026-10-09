import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  StoreChipsSkeleton,
  StoreRailsSkeleton,
} from "@/components/templates/store-skeleton";
import { TemplatesGraphic } from "@/components/templates/templates-graphic";

export default function Loading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-busy
      aria-label="Loading templates"
    >
      <section className="grid items-center gap-8 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div aria-hidden className="hidden lg:order-last lg:block">
          <TemplatesGraphic className="h-auto w-full" />
        </div>
        <div className="@container min-w-0">
          <TextLine shimmer type="text-3xl" className="w-36" />
          {/* A <p>'s 1.6 line-height (globals.css); ~33.5rem of text, wraps below. */}
          <div className="mt-1 text-sm leading-[1.6]">
            <TextLine shimmer className="w-[33.5rem] max-w-full" />
            <TextLine
              shimmer
              type="hidden @max-[33.5rem]:flex"
              className="w-36"
            />
          </div>
          <div className="mt-5 flex max-w-md items-center gap-2">
            <Skeleton className="h-10 min-w-0 flex-1" shimmer />
            <Skeleton className="size-10 shrink-0" shimmer />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Skeleton className="h-9 w-59" shimmer />
            <Skeleton className="h-9 w-45" shimmer />
          </div>
        </div>
      </section>

      <StoreChipsSkeleton />
      <StoreRailsSkeleton />
    </div>
  );
}
