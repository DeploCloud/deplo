"use client";

import { Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bone } from "@/components/ui/skeleton";
import {
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { StorageTabs } from "@/components/storage/storage-tabs";
import {
  DatabasesToolbar,
  gridClass,
} from "@/components/storage/databases-grid";
import { DatabaseCardSkeleton } from "@/components/storage/database-card";
import { MARQUEE_BOX } from "@/components/shared/card-selection";

const TABS = [
  ["databases", "Databases"],
  ["destinations", "Destinations"],
  ["backups", "Backups"],
] as const;
const noop = () => {};

export default function Loading() {
  return (
    <div className="space-y-3" aria-busy>
      <PageHeader
        docs="databases.overview"
        title="Storage"
        description="Managed databases, backup destinations and scheduled backups."
      />
      <StorageTabs defaultTab="databases">
        <UnderlineTabsList>
          {TABS.map(([value, label]) => (
            <UnderlineTabsTrigger key={value} value={value}>
              {label}
              <Bone box className="ml-2">
                <Badge variant="muted">1</Badge>
              </Bone>
            </UnderlineTabsTrigger>
          ))}
        </UnderlineTabsList>
        <TabsContent value="databases" className="space-y-4">
          <div className="space-y-4">
            <DatabasesToolbar
              query=""
              onQuery={noop}
              engine="all"
              onEngine={noop}
              status="all"
              onStatus={noop}
              view="grid"
              onView={noop}
              createButton={
                <Bone box>
                  <Button>
                    <Plus className="size-4" />
                    New Database
                  </Button>
                </Bone>
              }
            />
            <div className="relative min-h-[60vh]">
              <div className={MARQUEE_BOX} />
              <div className={gridClass("grid")}>
                {[0, 1, 2].map((i) => (
                  <DatabaseCardSkeleton key={i} />
                ))}
              </div>
            </div>
          </div>
        </TabsContent>
      </StorageTabs>
    </div>
  );
}
