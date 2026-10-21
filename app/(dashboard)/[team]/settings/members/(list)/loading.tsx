import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [handle, name, role badge] per member card.
const CARDS: [string, string, string][] = [
  ["w-24", "w-20", "w-14"],
  ["w-20", "w-28", "w-16"],
  ["w-28", "w-16", "w-14"],
  ["w-16", "w-24", "w-18"],
  ["w-24", "w-20", "w-16"],
  ["w-20", "w-24", "w-14"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading members"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TextLine type={titleClass.page} className="w-24" />
            <Skeleton className="h-[22px] w-7" />
          </div>
          <TextLine type="text-sm leading-[1.6]" className="w-80 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-[132px]" />
          <Skeleton className="h-8 w-[120px]" />
        </div>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-full sm:w-44" />
        <Skeleton className="hidden h-[38px] w-[74px] rounded-lg sm:block" />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {CARDS.map(([handle, name, role], i) => (
          <div
            key={i}
            className="flex h-full flex-col gap-3 rounded-lg border border-border p-4"
          >
            <div className="flex w-full items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1">
                <TextLine
                  type="text-sm leading-[1.6] font-medium"
                  className={handle}
                />
                <TextLine type="text-xs leading-[1.6]" className={name} />
              </div>
              <Skeleton className="size-4 shrink-0" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Skeleton className={`h-[22px] ${role}`} />
              <Skeleton className="h-[22px] w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
