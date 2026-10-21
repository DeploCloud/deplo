import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [handle, meta] per user card; four fill a row of the widest grid.
const CARDS: [string, string][] = [
  ["w-24", "w-36"],
  ["w-20", "w-32"],
  ["w-28", "w-40"],
  ["w-16", "w-32"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading users"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TextLine type={titleClass.page} className="w-16" />
            <Skeleton className="h-[22px] w-7" />
          </div>
          <TextLine type="text-sm leading-[1.6]" className="w-64 max-w-full" />
        </div>
        <Skeleton className="h-8 w-[124px]" />
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Skeleton className="h-9 flex-1" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-9 w-full sm:w-40" />
        ))}
        <Skeleton className="hidden h-[38px] w-[74px] rounded-lg sm:block" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {CARDS.map(([handle, meta], i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-lg border border-border p-3"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <TextLine
                  type="text-sm leading-[1.6] font-medium"
                  className={handle}
                />
                <TextLine type="text-xs leading-[1.6]" className={meta} />
              </div>
              <Skeleton className="size-4 shrink-0" />
            </div>
            <Skeleton className="-mr-1 size-8 shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
