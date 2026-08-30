// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";

/**
 * Without this, the route fell back to the LIST's loading.tsx and a click on
 * "Manage" flashed a grid of server cards - a skeleton of the page you just left.
 */
export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-5xl space-y-6"
      role="status"
      aria-busy
      aria-label="Loading server"
    >
      <div className="space-y-3">
        {/* Back to Servers */}
        <Skeleton className="-ml-2 h-8 w-28 rounded-md" />
        {/* Name + host badge + health chip, with Check status pinned right */}
        <div className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-24 rounded-md" />
          <Skeleton className="h-5 w-20 rounded-md" />
          <Skeleton className="ml-auto h-8 w-32 rounded-md" />
        </div>
        {/* IP */}
        <Skeleton className="mt-1 h-4 w-32" />
      </div>

      {/* Tab strip - six triggers on a 48px underlined row */}
      <div className="flex h-12 items-center gap-1 border-b border-border">
        {["w-20", "w-16", "w-24", "w-26", "w-18", "w-22"].map((w, tab) => (
          <Skeleton key={tab} className={`mx-3 h-4 ${w}`} />
        ))}
      </div>

      {/* Overview: four hardware-spec tiles, then the Agent card */}
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, spec) => (
            <div
              key={spec}
              className="rounded-lg border border-border bg-muted/30 p-3"
            >
              <div className="flex items-center gap-1.5">
                <Skeleton className="size-3.5 rounded" />
                <Skeleton className="h-3 w-12" />
              </div>
              <div className="mt-1 flex items-baseline gap-1">
                <Skeleton className="h-5 w-8" />
                <Skeleton className="h-3 w-12" />
              </div>
            </div>
          ))}
        </div>

        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-16" />
            <Skeleton className="mt-1 h-4 w-96 max-w-full" />
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Skeleton className="h-5 w-24 rounded-md" />
            <Skeleton className="h-8 w-36 rounded-md" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
