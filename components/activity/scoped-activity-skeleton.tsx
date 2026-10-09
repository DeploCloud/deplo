import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const EVENTS = ["w-24", "w-20", "w-20", "w-16", "w-12"];
const PEOPLE = ["w-12", "w-16"];
const ROWS: [string, string][] = [
  ["w-12", "w-56"],
  ["w-12", "w-64"],
  ["w-12", "w-60"],
  ["w-16", "w-48"],
  ["w-12", "w-72"],
  ["w-12", "w-52"],
  ["w-16", "w-60"],
  ["w-12", "w-44"],
];

function SummaryBlock({
  title,
  rows,
  round,
}: {
  title: string;
  rows: string[];
  round?: boolean;
}) {
  return (
    <div>
      <div className="px-2 py-1">
        <TextLine type="text-xs" className={title} />
      </div>
      {rows.map((w, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1">
          <Skeleton
            className={cn(
              "shrink-0",
              round ? "size-5 rounded-full" : "size-4 rounded",
            )}
          />
          <TextLine type="text-sm" className={w} />
          <TextLine type="ml-auto pl-2 text-xs" className="w-4" />
        </div>
      ))}
    </div>
  );
}

/** ScopedActivity's layout: the feed beside a rail of filters and counts. */
export function ScopedActivitySkeleton() {
  return (
    <div className="grid items-start gap-6 lg:max-w-6xl lg:grid-cols-[minmax(0,42rem)_20rem] lg:justify-between">
      <aside className="h-fit space-y-4 lg:col-start-2 lg:row-start-1">
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center lg:flex-col lg:items-stretch lg:py-0">
          <div className="flex min-w-0 flex-1">
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-9 sm:w-32 lg:w-auto" />
          <div className="flex min-w-0 flex-1">
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
        <div className="hidden space-y-3 lg:block">
          <TextLine type="text-xs" className="w-24" />
          <SummaryBlock title="w-12" rows={EVENTS} />
          <SummaryBlock title="w-12" rows={PEOPLE} round />
        </div>
      </aside>
      <ol className="relative min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
        <span
          aria-hidden
          className="absolute inset-y-0 left-4 w-px -translate-x-1/2 bg-border"
        />
        <li className="py-2">
          <TextLine type="text-xs" className="w-36" />
        </li>
        {ROWS.map(([actor, sentence], i) => (
          <li key={i} className="relative flex items-start gap-3">
            <Skeleton className="relative z-10 size-8 shrink-0 rounded-full ring-4 ring-background" />
            <div className="min-w-0 flex-1">
              <div className="flex min-h-8 items-center gap-1.5">
                <TextLine type="text-sm" className={actor} />
                <TextLine type="text-xs" className="w-12" />
              </div>
              <div className="mt-1 flex items-center justify-between gap-3">
                <TextLine
                  type="text-sm leading-[1.6]"
                  className={cn("max-w-full", sentence)}
                />
                <TextLine type="shrink-0 text-xs" className="w-16" />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
