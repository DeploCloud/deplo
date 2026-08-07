import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors `AccountPanel`: the profile card (avatar beside the name field)
 * and the email card (two fields side by side). Both always render, so both
 * are drawn.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading account"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-48" />
        </div>
      </div>

      <div className="space-y-4">
        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-14" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Skeleton shimmer className="size-12 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton shimmer className="h-9 w-full rounded-md" />
              </div>
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-8 w-16 rounded-md" />
            </div>
          </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-12" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Skeleton className="h-4 w-12" />
                <Skeleton shimmer className="h-9 w-full rounded-md" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton shimmer className="h-9 w-full rounded-md" />
              </div>
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-8 w-28 rounded-md" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
