import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading storage"
    >
      {/* PageHeader */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-96" />
        </div>
      </div>

      {/* Tabs */}
      <div>
        {/* UnderlineTabsList: Databases / S3 Destinations / Backups (each with a count badge) */}
        <div className="flex h-12 items-center gap-1 border-b border-border">
          <div className="flex h-12 items-center gap-2 px-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-5 w-6 rounded-md" />
          </div>
          <div className="flex h-12 items-center gap-2 px-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-5 w-6 rounded-md" />
          </div>
          <div className="flex h-12 items-center gap-2 px-3">
            <Skeleton className="h-4 w-14" />
            <Skeleton className="h-5 w-6 rounded-md" />
          </div>
        </div>

        {/* Databases tab body (default) */}
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-80" />
            <Skeleton className="h-8 w-32 rounded-md" />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardContent className="space-y-4 p-5">
                  {/* header: icon + name/type, status + menu */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <Skeleton className="size-10 rounded-lg" />
                      <div className="space-y-1.5">
                        <Skeleton className="h-4 w-32" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-5 w-20 rounded-md" />
                      <Skeleton className="size-8 rounded-md" />
                    </div>
                  </div>

                  {/* connection string */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Skeleton className="h-3 w-28" />
                      <Skeleton className="h-3 w-14" />
                    </div>
                    <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-2.5 py-1.5">
                      <Skeleton className="h-4 w-full" />
                    </div>
                  </div>

                  {/* meta: host:port · size · age */}
                  <div className="flex items-center gap-4">
                    <Skeleton className="h-3 w-28" />
                    <Skeleton className="h-3 w-12" />
                    <Skeleton className="ml-auto h-3 w-16" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
