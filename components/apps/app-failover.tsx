"use client";

import { HardDrive, TriangleAlert } from "lucide-react";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";
import { FailoverPromises } from "@/components/storage/database-failover";
import { BACKUP_PAUSE_NOTE } from "@/lib/apps/failover-copy";
import { FAILOVER_PROMISES } from "@/lib/databases/failover-copy";
import { gqlAction } from "@/lib/graphql-client";
import type { AppFailover } from "@/lib/data/apps/failover";

const BRING_BACK = /* GraphQL */ `
  mutation BringAppBack($id: String!) {
    bringAppBack(id: $id) {
      id
    }
  }
`;

/** While its server is stopped: the App waits, and one click brings it back from the named backup. */
export function AppWaitingNotice({
  appId,
  name,
  failover,
  canRestore,
}: {
  appId: string;
  name: string;
  failover: AppFailover | null;
  canRestore: boolean;
}) {
  if (!failover?.waiting) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-2.5 text-sm">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div className="space-y-1">
          <p className="font-medium">
            {name} is waiting for {failover.serverName}
          </p>
          <p className="text-muted-foreground">
            {failover.why ??
              "It keeps data on that server, so it starts nowhere else on its own."}
          </p>
        </div>
      </div>
      {failover.bringBack && canRestore && (
        <ConfirmAction
          trigger={
            <Button size="sm" variant="outline" className="shrink-0">
              {failover.bringBack}
            </Button>
          }
          title={`Bring ${name} back from a backup?`}
          description={
            <>
              <strong>{name}</strong> starts on another server of{" "}
              {failover.cluster}, from that backup.
            </>
          }
          consequence="Anything it wrote after that backup is lost."
          confirmLabel="Bring it back"
          successMessage={`${name} is coming back on another server`}
          onConfirm={() => gqlAction(BRING_BACK, { id: appId })}
        />
      )}
    </div>
  );
}

/** How an App that keeps data on a cluster member fails over, in one sentence. */
export function AppFailoverCard({
  failover,
}: {
  failover: AppFailover | null;
}) {
  if (!failover) return null;
  return (
    <Card>
      <CardContent className="flex items-start gap-3 pt-6">
        <HardDrive className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-2">
          <div>
            <p className="text-sm font-medium">Failover</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {failover.sentence} <DocsLink topic="clusters.appData" />
            </p>
          </div>
          {failover.disk === "volume" && (
            <>
              <FailoverPromises promises={FAILOVER_PROMISES} />
              <p className="text-xs text-muted-foreground">
                {BACKUP_PAUSE_NOTE}
              </p>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
