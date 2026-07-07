import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading dev mode"
    >
      {/* Dev Mode — enable toggle + container lifecycle */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-5 w-24" />
              </div>
              <Skeleton className="h-4 w-72 max-w-full" />
              <Skeleton className="h-4 w-56 max-w-full" />
            </div>
            {/* Status badge */}
            <Skeleton className="h-6 w-20 rounded-md" />
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Enable toggle */}
          <div className="flex items-center justify-between rounded-lg border border-border p-4">
            <div className="space-y-1 pr-4">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-64 max-w-full" />
            </div>
            <Skeleton className="h-5 w-9 rounded-full" />
          </div>

          {/* Container lifecycle */}
          <div className="space-y-3 border-t border-border pt-5">
            <div className="space-y-1">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-full max-w-lg" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-8 w-24 rounded-md" />
              <Skeleton className="h-8 w-20 rounded-md" />
              <span className="mx-1 hidden h-5 w-px bg-border sm:inline-block" />
              <Skeleton className="h-8 w-40 rounded-md" />
              <Skeleton className="h-8 w-44 rounded-md" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs + default (VS Code) tab content */}
      <div className="space-y-6">
        {/* Underline tabs list */}
        <div className="flex h-12 items-center gap-1 border-b border-border">
          <div className="flex items-center gap-2 px-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-16" />
          </div>
          <div className="flex items-center gap-2 px-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-20" />
          </div>
          <div className="flex items-center gap-2 px-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-24" />
          </div>
          <div className="flex items-center gap-2 px-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-20" />
          </div>
        </div>

        {/* Open in VS Code (default tab) */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-3/4 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
              <div className="space-y-1">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <Skeleton className="h-8 w-36 rounded-md" />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
