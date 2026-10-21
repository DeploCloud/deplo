import { Card } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// [title, subtitle, installation badges] per host card: a GitHub App, then two connections.
const HOSTS: [string, string, string[]][] = [
  ["w-28", "w-24", ["w-24", "w-20"]],
  ["w-20", "w-44", []],
  ["w-24", "w-36", []],
];

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-busy aria-label="Loading git">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <TextLine type={titleClass.page} className="w-9" />
          <TextLine type="text-sm leading-[1.6]" className="w-120 max-w-full" />
        </div>
        <Skeleton className="h-8 w-27" />
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {HOSTS.map(([title, subtitle, badges], i) => (
          <Card key={i} className="p-4">
            <div className="flex items-start gap-3">
              <Skeleton className="size-10 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <TextLine
                  type="text-sm font-medium leading-[1.6]"
                  className={title}
                />
                <TextLine
                  type="mt-1 text-xs leading-[1.6]"
                  className={subtitle}
                />
              </div>
              <Skeleton className="-mr-1 size-8 shrink-0" />
            </div>
            {badges.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {badges.map((w) => (
                  <Skeleton key={w} className={`h-[22px] ${w}`} />
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
