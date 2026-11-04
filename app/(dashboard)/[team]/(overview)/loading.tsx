"use client";

import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bone } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/shared/page-header";
import { AddNewMenu } from "@/components/shared/add-new-menu";
import { AppSearch } from "@/components/apps/app-search";
import { AppCardSkeleton } from "@/components/apps/app-card";
import { ContainerCardSkeleton } from "@/components/apps/project-container-card";
import { FolderTrail } from "@/components/apps/apps-grid/folder-trail";
import { gridClass } from "@/components/apps/apps-grid/grid-contract";
import { MARQUEE_BOX } from "@/components/shared/card-selection";
import {
  ActivityTimeline,
  placeholderActivity,
} from "@/components/activity/activity-timeline";

const RECENT = placeholderActivity([
  "Redeployed the app from its latest commit",
  "Added a domain",
  "Changed an environment variable",
  "Deployed a new version",
  "Restarted the app",
  "Backup of database failed: upload to S3 did not complete",
]);

export default function Loading() {
  const params = useSearchParams();
  const view = params.get("view") === "list" ? "list" : "grid";
  const drilled = Boolean(params.get("folder") || params.get("project"));
  const flat = Boolean(params.get("q") || params.get("needs"));

  return (
    <div aria-busy className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="relative z-20 order-2 hidden space-y-6 2xl:block">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm lg:text-sm">
              Recent activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <ActivityTimeline
              loading
              variant="compact"
              showMark={false}
              items={RECENT}
            />
            <Button variant="outline" size="sm" className="w-full" disabled>
              View all activity
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="order-1 space-y-5" inert>
        <PageHeader
          title="Overview"
          actions={
            <Bone box>
              <AddNewMenu
                canCreateApp
                canCreateDatabase
                canCreateFolder
                canCreateProject
              />
            </Bone>
          }
        />
        <AppSearch initialQuery={params.get("q") ?? ""} initialView={view} />
        <div className="relative min-h-[60vh] space-y-6">
          <div className={MARQUEE_BOX} />
          {drilled && (
            <div className="px-1 py-1">
              <FolderTrail path={[]} view={view} />
            </div>
          )}
          {!drilled && !flat && (
            <div className={gridClass(view)}>
              <ContainerCardSkeleton
                view={view}
                count="2 apps · 2 environments"
              />
              <ContainerCardSkeleton view={view} />
            </div>
          )}
          <div className={gridClass(view)}>
            {Array.from({ length: 6 }, (_, i) => (
              <AppCardSkeleton key={i} view={view} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
