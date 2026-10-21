import { Card } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { NotificationIllustration } from "@/components/settings/notification-illustration";

// [name, target] per channel row.
const CHANNELS: [string, string][] = [
  ["w-20", "w-40"],
  ["w-16", "w-32"],
  ["w-24", "w-44"],
  ["w-14", "w-28"],
];

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading notifications"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <TextLine type={titleClass.page} className="w-32" />
          <TextLine type="text-sm leading-[1.6]" className="w-100 max-w-full" />
        </div>
        <Skeleton className="h-8 w-29" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <div className="space-y-3">
            <div className="flex w-fit items-center gap-1.5 px-1 text-sm font-medium">
              <Skeleton className="size-4" />
              <TextLine className="w-24" />
              <Skeleton className="h-[22px] w-10" />
            </div>
            <div className="grid items-start gap-3 sm:grid-cols-2">
              {CHANNELS.map(([name, target], i) => (
                <Card key={i} className="flex items-center gap-3 p-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Skeleton className="size-9 shrink-0 rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <TextLine type="text-sm font-medium" className={name} />
                      <TextLine
                        type="mt-1 font-mono text-xs"
                        className={target}
                      />
                    </div>
                  </div>
                  <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                  <Skeleton className="size-8 shrink-0" />
                </Card>
              ))}
            </div>
          </div>
        </div>
        <aside className="hidden xl:sticky xl:top-20 xl:block">
          <NotificationIllustration />
        </aside>
      </div>
    </div>
  );
}
