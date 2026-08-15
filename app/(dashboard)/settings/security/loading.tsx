import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

/**
 * Mirrors the four cards the security page always renders: password,
 * two-factor, passkeys, and the active sessions list.
 */
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading security settings"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      <div className="space-y-4">
        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Skeleton className="h-4 w-28" />
                <Skeleton shimmer className="h-9 w-full rounded-md" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton shimmer className="h-9 w-full rounded-md" />
              </div>
          </CardContent>
        </Card>

        <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-32" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
        </CardHeader>
          <CardContent>
            <Skeleton className="h-14 w-full rounded-lg" />
          </CardContent>
        </Card>

        <Card>
        <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
          <div className="flex items-center gap-2">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="size-3.5 rounded-full" />
          </div>
          <Skeleton className="h-8 w-32 rounded-md" />
        </CardHeader>
          <CardContent className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{ ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s` }}
                className="h-12 w-full rounded-lg"
              />
            ))}
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
          <CardContent className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton
                key={i}
                shimmer
                style={{ ["--shimmer-delay" as string]: `-${(i * 0.09).toFixed(2)}s` }}
                className="h-16 w-full rounded-lg"
              />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
