"use client";

import { useSearchParams } from "@/lib/nav";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { UpdatesSkeleton } from "@/components/settings/deplo-updates-tab";

// The tab comes from the address, so the skeleton is the one about to load.
export default function Loading() {
  const tab = useSearchParams().get("tab");
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy
      aria-label="Loading Deplo settings"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-16" />
        <div className="flex h-5 items-center gap-2">
          <TextLine type="font-mono text-sm" className="w-32" />
          <Skeleton className="h-[22px] w-11" />
        </div>
      </div>
      <div className="flex h-12 items-center gap-1 border-b border-border">
        {["w-[92px]", "w-[100px]", "w-[104px]"].map((w) => (
          <Skeleton key={w} className={`h-5 ${w}`} />
        ))}
      </div>
      {tab === "updates" ? (
        <UpdatesSkeleton />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {["", "", "lg:col-span-2"].map((span, i) => (
            <Card key={i} className={span}>
              <CardHeader className="space-y-1">
                <TextLine type="text-base font-semibold" className="w-36" />
                <TextLine type="text-sm" className="w-64" />
              </CardHeader>
              <CardContent className="space-y-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
