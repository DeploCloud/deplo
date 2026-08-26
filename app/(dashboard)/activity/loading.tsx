import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// One tuple per placeholder entry: the message width, and whether the actor line
// carries an avatar - a system actor has none.
const ENTRIES: [string, boolean][] = [
  ["w-64", true],
  ["w-80", false],
  ["w-56", true],
  ["w-72", true],
  ["w-48", false],
];

// Day headings, in the page's own order: "Today" is short, the dates below it
// spell out a weekday.
const DAYS = [
  { key: "today", label: "w-12", entries: 5 },
  { key: "earlier", label: "w-40", entries: 3 },
];

export default function Loading() {
  return (
    <Card role="status" aria-busy aria-label="Loading activity">
      <CardContent className="p-6">
        <div className="space-y-8">
          {DAYS.map((day) => (
            <section key={day.key} className="space-y-4">
              <Skeleton className={cn("h-3", day.label)} />

              <ol className="relative space-y-5 pl-2">
                {/* Vertical timeline connector */}
                <span
                  aria-hidden
                  className="absolute top-2 bottom-2 left-[18px] w-px bg-border"
                />

                {ENTRIES.slice(0, day.entries).map(([width, avatar], i) => (
                  <li key={i} className="relative flex items-start gap-4">
                    {/* The entry's own circle, with its glyph as the placeholder. */}
                    <div className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                      <Skeleton className="size-4 rounded" />
                    </div>
                    <div className="min-w-0 flex-1 pt-1">
                      <Skeleton className={cn("h-4", width)} />
                      <div className="mt-1.5 flex items-center gap-1.5">
                        {avatar && (
                          <Skeleton className="size-4 shrink-0 rounded-full" />
                        )}
                        <Skeleton className="h-3 w-36" />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
