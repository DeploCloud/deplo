import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { EnvTableSkeleton } from "@/components/env/env-skeleton";

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading variables" aria-busy>
      {/* PageHeader: "Environment Variables" + long description */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-[30rem]" />
        </div>
      </div>

      {/* UnderlineTabsList: App / Shared (admin-only "All teams" tab omitted) */}
      <div className="flex h-12 items-center gap-1 border-b border-border">
        <div className="px-3">
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="px-3">
          <Skeleton className="h-4 w-16" />
        </div>
      </div>

      {/* App tab body: per-app cards, each with an editable env table */}
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, card) => (
          <Card key={card}>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <Skeleton className="h-5 w-40" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-16 rounded-md" />
                <Skeleton className="h-8 w-16 rounded-md" />
              </div>
            </CardHeader>
            <CardContent>
              <EnvTableSkeleton rows={3} className="rounded-lg" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
