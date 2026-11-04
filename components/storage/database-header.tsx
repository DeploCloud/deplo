"use client";

import { MoreHorizontal, RotateCcw, RotateCw, Square } from "lucide-react";
import { useFlatPathname } from "@/lib/nav";
import { titleCase } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import { DetailFrame } from "@/components/layout/detail-frame";
import { LogoEditLink } from "@/components/shared/logo-edit-link";
import { StatusBadge } from "@/components/shared/status-badge";
import { titleClass } from "@/components/shared/page-header";
import { DB_NAMES } from "@/components/storage/db-engines";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { DatabaseStatusBadge } from "@/components/storage/database-status-badge";
import { DatabaseControls } from "@/components/storage/database-controls";
import { DatabaseRedeployButton } from "@/components/storage/database-redeploy-button";
import { DatabaseActionsMenu } from "@/components/storage/database-actions-menu";
import type { DatabaseStatus, DatabaseType } from "@/lib/types/database";

export type DatabaseHeaderData = {
  id: string;
  name: string;
  type: DatabaseType;
  logo: string | null;
  version: string;
  status: DatabaseStatus;
};

/** The database page header; without `db` it is its own loading state. */
export function DatabaseHeader({
  db,
  canConfigure = false,
  canDelete = false,
}: {
  db?: DatabaseHeaderData;
  canConfigure?: boolean;
  canDelete?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        {db ? (
          <LogoEditLink
            href={`/storage/databases/${db.id}/settings`}
            label="General settings"
          >
            <DatabaseLogo type={db.type} logo={db.logo} size={44} />
          </LogoEditLink>
        ) : (
          <Skeleton className="size-11 shrink-0 rounded-md" />
        )}
        <div>
          <div className="flex items-center gap-2">
            <h1 className={titleClass.page}>
              {db ? db.name : <Bone>database</Bone>}
            </h1>
            {db ? (
              <DatabaseStatusBadge id={db.id} status={db.status} />
            ) : (
              <Bone box>
                <StatusBadge
                  status="running"
                  tinted
                  labels={{ running: "Running" }}
                />
              </Bone>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {db ? (
              <>
                {DB_NAMES[db.type] ?? titleCase(db.type)} database · v
                {db.version}
              </>
            ) : (
              <Bone>PostgreSQL database · v17</Bone>
            )}
          </p>
        </div>
      </div>
      {/* Below md the redeploy takes the whole first row; the rest share the second. */}
      <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-[1fr_1fr_auto] max-md:[&>:has([data-primary-action])]:order-first max-md:[&>:has([data-primary-action])]:col-span-full max-md:[&>:last-child]:col-start-3 max-md:[&>[data-primary-action]]:order-first max-md:[&>[data-primary-action]]:col-span-full">
        {db ? (
          <>
            <DatabaseControls id={db.id} status={db.status} />
            <DatabaseRedeployButton id={db.id} />
            <DatabaseActionsMenu
              id={db.id}
              name={db.name}
              canConfigure={canConfigure}
              canDelete={canDelete}
            />
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled>
              <Bone box className="gap-2">
                <Square className="size-4" />
                Stop
              </Bone>
            </Button>
            <Button variant="outline" size="sm" disabled>
              <RotateCw className="size-4" />
              Restart
            </Button>
            <Button data-primary-action="" size="sm" disabled>
              <RotateCcw className="size-4" />
              Redeploy
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled
              aria-label="Database actions"
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The database layout's frame while the layout itself is still loading. */
export function DatabaseFrameSkeleton({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = useFlatPathname();
  const id = /^\/storage\/databases\/([^/]+)/.exec(pathname)?.[1] ?? "";
  return (
    <DetailFrame
      mobile={{
        root: `/storage/databases/${id}`,
        name: "",
        parent: { href: "/storage", label: "Storage" },
      }}
      header={<DatabaseHeader />}
    >
      {children}
    </DetailFrame>
  );
}
