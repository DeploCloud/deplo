import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors `DeploSettingsPanel`. Two of its cards fetch from the hosts and
 * draw their own placeholder while they do - `h-14` for the HTTPS row and
 * `h-[5.5rem]` for the per-server certificates - so those exact heights are
 * used here and the handover from this skeleton to theirs is invisible.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading Deplo settings"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-4 w-56" />
        </div>
      </div>

      <div className="space-y-4">
        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-28" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton shimmer className="h-9 w-full max-w-sm rounded-md" />
              <Skeleton className="h-9 w-16 rounded-md" />
            </div>
            <Skeleton className="h-14 w-full rounded-lg" />
          </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton shimmer className="h-9 w-full max-w-xs rounded-md" />
              <Skeleton className="h-9 w-16 rounded-md" />
            </div>
            <Skeleton className="h-[5.5rem] w-full rounded-lg" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
