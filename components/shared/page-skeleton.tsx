import { Card, CardContent } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// A neutral page while one loads: never another page's skeleton left on screen.
const ROWS = ["w-48", "w-64", "w-40", "w-56"];

export function PageSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-busy aria-label="Loading">
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-28" />
        <TextLine type="text-sm leading-[1.6]" className="w-80 max-w-full" />
      </div>
      <Card>
        <CardContent className="divide-y divide-border p-0">
          {ROWS.map((w, i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <Skeleton className="size-8 shrink-0" />
              <div className="min-w-0 flex-1">
                <TextLine type="text-sm font-medium" className={w} />
                <TextLine type="text-xs" className="w-24" />
              </div>
              <Skeleton className="h-8 w-20 shrink-0" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
