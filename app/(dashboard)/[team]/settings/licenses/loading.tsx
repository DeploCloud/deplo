import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [package, license] per row.
const ROWS: [string, string][] = [
  ["w-40", "w-10"],
  ["w-28", "w-20"],
  ["w-48", "w-10"],
  ["w-32", "w-8"],
  ["w-36", "w-10"],
  ["w-24", "w-20"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading licenses"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <TextLine type={titleClass.page} className="w-52" />
            <Skeleton className="h-[22px] w-9" />
          </div>
          <TextLine type="text-sm leading-[1.6]" className="w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-[108px]" />
      </div>
      <div className="space-y-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 w-full sm:w-40" />
        </div>
        <div className="rounded-xl border border-border">
          {ROWS.map(([name, license], i) => (
            <div
              key={i}
              className="flex items-center gap-4 border-b border-border px-2 py-3 last:border-0"
            >
              <TextLine type="text-sm leading-[1.6]" className={name} />
              <Skeleton className="ml-auto h-5 w-14 sm:ml-0" />
              <Skeleton className={`hidden h-5 sm:block ${license}`} />
              <Skeleton className="ml-auto hidden size-7 sm:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
