import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const GROUPS = [
  { label: "w-14", rows: 5 },
  { label: "w-24", rows: 4 },
];

const ROW_WIDTHS = ["w-64", "w-72", "w-56", "w-80", "w-60"];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading activity"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-[22rem]" />
        </div>
      </div>

      <Card>
        <CardContent className="p-6">
          <div className="space-y-8">
            {GROUPS.map((group) => (
              <section key={group.label} className="space-y-4">
                <Skeleton className={`h-3 ${group.label}`} />

                <ol className="relative space-y-5 pl-2">
                  {/* Vertical timeline connector */}
                  <span
                    aria-hidden
                    className="absolute left-[18px] top-2 bottom-2 w-px bg-border"
                  />

                  {Array.from({ length: group.rows }).map((_, i) => (
                    <li key={i} className="relative flex items-start gap-4">
                      <Skeleton className="relative z-10 size-8 shrink-0 rounded-full" />
                      <div className="min-w-0 flex-1 pt-1">
                        <Skeleton
                          className={`h-4 ${ROW_WIDTHS[i % ROW_WIDTHS.length]}`}
                        />
                        <Skeleton className="mt-2 h-3 w-40" />
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
