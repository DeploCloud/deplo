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

      {/* UnderlineTabsList: Service / Environments / Shared / Team globals (admin-only tab omitted) */}
      <div className="flex h-12 items-center gap-1 border-b border-border">
        <div className="px-3">
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="px-3">
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="px-3">
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="px-3">
          <Skeleton className="h-4 w-24" />
        </div>
      </div>

      {/* Service tab body: per-service cards, each with a read-only env table */}
      <div className="space-y-4">
        {Array.from({ length: 2 }).map((_, card) => (
          <Card key={card}>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-8 w-24 rounded-md" />
            </CardHeader>
            <CardContent>
              <EnvTableSkeleton rows={3} actions={false} className="rounded-lg" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
