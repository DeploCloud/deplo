import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-6"
      role="status"
      aria-busy
      aria-label="Loading this member's access"
    >
      {/* "Members" back link */}
      <Skeleton className="h-5 w-24" />

      {/* Header: avatar, @username with its badges, and the meta line */}
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-5 w-20 rounded-md" />
          </div>
          <Skeleton className="h-4 w-56" />
        </div>
      </div>

      {/* The three tab triggers, then the first panel's card */}
      <div className="flex gap-6 border-b border-border pb-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
      <Card>
        <CardContent className="space-y-3 pt-6">
          <Skeleton className="h-5 w-28" />
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full rounded-lg" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
