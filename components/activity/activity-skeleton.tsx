import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// [actor, sentence widths]: one sentence is a single entry, more is a folded run.
const ROWS: [string, string[]][] = [
  ["w-8", ["w-66"]],
  ["w-8", ["w-43"]],
  ["w-8", ["w-31"]],
  ["w-20", ["w-37"]],
  ["w-20", ["w-31"]],
  ["w-8", ["w-59", "w-59"]],
  ["w-8", ["w-33"]],
  ["w-8", ["w-51", "w-51"]],
  ["w-8", ["w-74"]],
  ["w-8", ["w-48"]],
  ["w-20", ["w-37", "w-37", "w-37"]],
  ["w-8", ["w-56"]],
  ["w-8", ["w-40"]],
  ["w-8", ["w-64", "w-64"]],
  ["w-20", ["w-31"]],
  ["w-8", ["w-52"]],
  ["w-8", ["w-44"]],
  ["w-8", ["w-60"]],
  ["w-20", ["w-37", "w-37"]],
  ["w-8", ["w-48"]],
  ["w-8", ["w-70"]],
  ["w-8", ["w-36"]],
  ["w-8", ["w-56", "w-56"]],
  ["w-8", ["w-42"]],
];
const EVENTS = ["w-21", "w-8", "w-15", "w-15", "w-21"];
const PEOPLE = ["w-7", "w-12", "w-7", "w-16", "w-8"];

function SummaryBlock({
  title,
  rows,
  avatar,
  more,
}: {
  title: string;
  rows: string[];
  avatar?: boolean;
  more?: boolean;
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
              avatar ? "size-5 rounded-full" : "size-4 rounded",
            )}
          />
          <TextLine type="text-sm" className={w} />
          <TextLine type="ml-auto pl-2 text-xs" className="w-5" />
        </div>
      ))}
      {more && (
        <div className="flex items-center gap-2 px-2 py-1">
          <Skeleton className="size-4 shrink-0 rounded" />
          <TextLine type="text-sm" className="w-21" />
        </div>
      )}
    </div>
  );
}

/** The Activity page: the feed beside a rail of filters and counts. */
export function ActivitySkeleton() {
  return (
    <div
      role="status"
      aria-busy
      aria-label="Loading activity"
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12"
    >
      <aside className="h-fit space-y-4 lg:col-start-2 lg:row-start-1">
        <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center lg:flex-col lg:items-stretch lg:py-0">
          {[0, 1, 2, 3].map((i) =>
            i === 1 ? (
              <Skeleton key={i} className="h-9 shrink-0 sm:w-32 lg:w-auto" />
            ) : (
              <div key={i} className="flex min-w-0 flex-1">
                <Skeleton className="h-9 w-full" />
              </div>
            ),
          )}
        </div>
        <div className="hidden space-y-3 lg:block">
          <TextLine type="text-xs" className="w-22" />
          <SummaryBlock title="w-10" rows={EVENTS} more />
          <SummaryBlock title="w-10" rows={PEOPLE} avatar />
        </div>
      </aside>
      <ol className="relative min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
        <span
          aria-hidden
          className="absolute inset-y-0 left-4 w-px -translate-x-1/2 bg-border"
        />
        <li className="-mx-1 px-1 py-2">
          <TextLine type="text-xs" className="w-44" />
        </li>
        {ROWS.map(([actor, lines], i) => (
          <li key={i} className="relative flex items-start gap-3">
            <Skeleton className="relative z-10 size-8 shrink-0 rounded-full ring-4 ring-background" />
            <div className="min-w-0 flex-1">
              <div className="flex min-h-8 items-center gap-1.5">
                <TextLine type="text-sm" className={actor} />
                <TextLine type="text-xs" className="w-11" />
                {lines.length > 1 && (
                  <TextLine type="text-xs" className="w-14" />
                )}
              </div>
              {lines.length > 1 ? (
                <div className="mt-1 space-y-1">
                  {lines.map((w, j) => (
                    <div
                      key={j}
                      className="flex items-center justify-between gap-3"
                    >
                      <TextLine type="text-sm" className={w} />
                      <TextLine type="shrink-0 text-xs" className="w-17" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mt-1 flex items-center justify-between gap-3">
                  <TextLine type="text-sm leading-[1.6]" className={lines[0]} />
                  <TextLine type="shrink-0 text-xs" className="w-17" />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
