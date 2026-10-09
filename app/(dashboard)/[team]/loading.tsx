import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [name, url, commit message, repo] per card; enough rows to run past the fold.
const CARDS: [string, string, string, string][] = [
  ["w-10", "w-20", "w-36", "w-36"],
  ["w-16", "w-40", "w-56", "w-36"],
  ["w-10", "w-24", "w-36", "w-28"],
  ["w-12", "w-24", "w-36", "w-40"],
  ["w-16", "w-14", "w-44", "w-16"],
  ["w-10", "w-24", "w-44", "w-16"],
  ["w-20", "w-20", "w-24", "w-16"],
  ["w-20", "w-28", "w-56", "w-36"],
  ["w-10", "w-56", "w-44", "w-16"],
  ["w-14", "w-32", "w-40", "w-28"],
];

// The sidebar's six recent events: [actor, sentence lines].
const RECENT: [string, string[]][] = [
  ["w-8", ["w-full", "w-20"]],
  ["w-8", ["w-40"]],
  ["w-8", ["w-32"]],
  ["w-16", ["w-36"]],
  ["w-16", ["w-32"]],
  ["w-8", ["w-full", "w-10"]],
];

export default function Loading() {
  return (
    <div
      className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_300px]"
      role="status"
      aria-busy
      aria-label="Loading dashboard"
    >
      <div className="relative z-20 order-2 hidden space-y-6 2xl:block">
        <Card>
          <CardHeader className="pb-3">
            <TextLine type="text-sm" className="w-28" />
          </CardHeader>
          <CardContent className="space-y-3">
            <ol className="space-y-4">
              {RECENT.map(([actor, lines], i) => (
                <li key={i} className="flex items-start gap-3">
                  <Skeleton className="size-6 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-h-6 items-center gap-1.5">
                      <TextLine type="text-sm" className={actor} />
                      <TextLine type="text-xs" className="w-14" />
                      <TextLine type="text-xs" className="w-20" />
                    </div>
                    <div className="mt-1">
                      {lines.map((w, j) => (
                        <TextLine
                          key={j}
                          type="text-sm leading-[1.6]"
                          className={w}
                        />
                      ))}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
            <Skeleton className="h-8 w-full rounded-md" />
          </CardContent>
        </Card>
      </div>

      <div className="order-1 space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TextLine type={titleClass.page} className="w-22" />
          <Skeleton className="h-8 w-[126px]" />
        </div>

        <div className="flex items-center gap-2">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="hidden h-[38px] w-[74px] rounded-lg sm:block" />
        </div>

        <div className="grid gap-4 sm:grid-cols-2 2xl:grid-cols-3">
          {CARDS.map(([name, url, message, repo], i) => (
            <Card key={i} className="flex flex-col gap-4 p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Skeleton className="size-9 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <TextLine type="font-medium" className={name} />
                    <div className="h-6 pt-1">
                      <TextLine type="text-xs" className={url} />
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Skeleton className="size-2.5 rounded-full" />
                  <Skeleton className="size-8" />
                </div>
              </div>
              <div className="rounded-lg border border-border bg-surface p-3">
                <div className="flex items-center gap-2">
                  <TextLine type="text-xs" className="w-[50px]" />
                  <TextLine type="text-xs" className={message} />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <TextLine type="text-xs" className="w-12" />
                  <TextLine type="text-xs" className="w-12" />
                  <TextLine type="text-xs" className={repo} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
