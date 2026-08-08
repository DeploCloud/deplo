import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors the notifications page, INCLUDING its second column. The old fallback
 * had one column, so the page jumped sideways the moment it arrived; the 260px
 * aside is reserved here even though the illustration inside it is decoration.
 *
 * It draws the CONFIGURED state, not the empty one: a fallback has to pick a
 * shape, and guessing "empty" would flash a dashed box at everyone whose page is
 * actually a list. The action sits in the page header, which is where the real
 * one is - the card header carries only its title and count.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading notification channels"
    >
      {/* PageHeader, with the Add channel button on its right. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0">
          <Card>
            <CardHeader>
              {/* Icon, title, info tip, then the "N on" count. */}
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-5 w-28" />
                <Skeleton className="size-3.5 rounded-full" />
                <Skeleton className="h-5 w-12 rounded-md" />
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton
                  key={i}
                  shimmer
                  style={{
                    ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s`,
                  }}
                  className="h-[4.25rem] w-full rounded-lg"
                />
              ))}
            </CardContent>
          </Card>
        </div>
        <aside className="hidden xl:block">
          <Skeleton className="mx-auto h-[22rem] w-full max-w-[260px] rounded-[2rem]" />
        </aside>
      </div>
    </div>
  );
}
