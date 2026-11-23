"use client";

import { HardDrive, TriangleAlert } from "lucide-react";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";
import { FailoverPromises } from "@/components/storage/database-failover";
import { TimeAgo } from "@/components/shared/time-ago";
import { AdvancedSection } from "@/components/apps/wizard/advanced-section";
import { REPLICATION_PROMISES } from "@/lib/apps/failover-copy";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
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
              {failover.sentence}{" "}
              <DocsLink
                topic={
                  failover.automatic
                    ? "clusters.replication"
                    : "clusters.appData"
                }
              />
            </p>
          </div>
          {failover.outOfReach && (
            <p className="flex items-start gap-1.5 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
              {failover.outOfReach}
            </p>
          )}
          {failover.disk === "volume" && failover.automatic && (
            <>
              <FailoverPromises promises={REPLICATION_PROMISES} />
              {failover.copies && <p className="text-sm">{failover.copies}</p>}
              {failover.copyRows.length > 0 && (
                <AdvancedSection>
                  <ul className="space-y-2 text-sm">
                    {failover.copyRows.map((r) => (
                      <li
                        key={r.server}
                        className="flex flex-wrap justify-between gap-x-4"
                      >
                        <span className="font-medium">{r.server}</span>
                        <span className="text-muted-foreground">
                          {r.state}
                          {r.lastCopyAt && (
                            <>
                              , last copy <TimeAgo at={r.lastCopyAt} live />
                            </>
                          )}
                          {r.behindSeconds != null &&
                            `, ${r.behindSeconds} s behind`}
                          {r.bytes > 0 && `, ${formatBytes(r.bytes)}`}
                          {r.error &&
                            r.state !== "Up to date" &&
                            `: ${r.error}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                </AdvancedSection>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
