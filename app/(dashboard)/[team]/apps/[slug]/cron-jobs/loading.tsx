import { Card, CardContent } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";

const ROWS: [string, string][] = [
  ["w-24", "w-56"],
  ["w-32", "w-64"],
];

export default function Loading() {
  return (
    <div
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading cron jobs"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <TextLine type="text-sm font-medium" className="w-16" />
          <TextLine
            type="mt-1 text-sm leading-[1.6]"
            className="w-[37rem] max-w-full"
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="size-8" />
          <Skeleton className="h-8 w-32" />
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2 pt-6">
          {ROWS.map(([name, schedule], i) => (
            <div key={i} className="rounded-lg border border-border">
              <div className="flex items-center gap-3 p-3">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <Skeleton className="size-4 shrink-0 rounded" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <TextLine type="text-sm" className={name} />
                      <Skeleton className="h-5 w-16" />
                    </div>
                    <TextLine
                      type="mt-1 text-xs leading-[1.6]"
                      className={schedule}
                    />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {[0, 1, 2].map((b) => (
                    <Skeleton key={b} className="size-9" />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
