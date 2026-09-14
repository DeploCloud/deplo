"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { BackupGraphic } from "@/components/apps/backup-graphic";
import { BackupScheduleGraphic } from "@/components/storage/backup-schedule-graphic";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { RecoveryKeyNudge } from "@/components/storage/recovery-key";
import { RestoreFromFile } from "@/components/storage/restore-from-file";
import { OptimisticList } from "@/components/shared/optimistic-list";
import type { BackupDTO } from "@/lib/data/backups/schedules";
import type { BackupRun } from "@/lib/types/backup";
import { noun, type BackupTarget, type Destination } from "./target";
import { BackUpMenu } from "./back-up-menu";
import { BackUpNow } from "./back-up-now";
import { ScheduleBackup } from "./schedule-wizard";
import { ScheduleRow } from "./schedule-row";
import { PendingRunRow, RunRow } from "./run-row";

// BackupsPanel - the Backups tab: schedules, one-off runs, and the artifacts they produced.
export function BackupsPanel({
  target,
  schedules,
  runs,
  destinations,
  canManage,
  canRestore,
  canDelete,
  canTestDestinations,
}: {
  target: BackupTarget;
  schedules: BackupDTO[];
  runs: BackupRun[];
  destinations: Destination[];
  /** `manage_backups` - schedule, run, edit, delete. */
  canManage: boolean;
  /** `restore_backups` - its own, because a restore overwrites live data (and
   *  a download hands over every byte, which is the same power). */
  canRestore: boolean;
  /** `delete_backups` - its own capability, and the only irreversible one on
   *  this screen: the artifact is the last copy of that moment. */
  canDelete: boolean;
  /** `manage_backup_destinations`: whether this user may run the live connection
   *  probe the picker fires, and take a destination's recovery key. */
  canTestDestinations: boolean;
}) {
  const router = useRouter();
  const noDeps = destinations.length === 0;
  const [runOpen, setRunOpen] = React.useState(false);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [fileOpen, setFileOpen] = React.useState(false);
  const destName = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d.name] as const)),
    [destinations],
  );

  // A dump runs on the host for minutes with nothing on this page changing by itself,
  // and the mutation that started it only resolves at the very END.
  const [pending, setPending] = React.useState<
    { id: number; destinationId: string; baseline: number }[]
  >([]);
  const runningNow = runs.filter((r) => r.status === "running").length;
  // Retire a placeholder the moment a real `running` row shows up above the count
  // that stood when it was created: the swap happens in one commit, so there is
  // never a duplicate.
  const [seenRunning, setSeenRunning] = React.useState(runningNow);
  if (runningNow !== seenRunning) {
    setSeenRunning(runningNow);
    if (pending.some((x) => runningNow > x.baseline))
      setPending((p) => p.filter((x) => runningNow <= x.baseline));
  }

  const nextPendingId = React.useRef(0);
  const startRun = React.useCallback(
    (destinationId: string, run: () => Promise<unknown>) => {
      const id = nextPendingId.current++;
      // `runningNow` as of this render is the baseline: "has MY row landed yet?"
      // is answerable by the count alone, and the run's real id does not exist
      // on this side until the dump finishes.
      setPending((p) => [...p, { id, destinationId, baseline: runningNow }]);
      void run().finally(() => setPending((p) => p.filter((x) => x.id !== id)));
    },
    [runningNow],
  );

  const anythingRunning =
    pending.length > 0 ||
    runningNow > 0 ||
    schedules.some((s) => s.lastStatus === "running");

  const unsavedKeyDestinations = React.useMemo(() => {
    if (!canTestDestinations) return [];
    const used = new Set([
      ...schedules.map((s) => s.destinationId),
      ...runs.map((r) => r.destinationId),
    ]);
    return destinations.filter(
      (d) => used.has(d.id) && d.encrypted && !d.recoveryKeySavedAt,
    );
  }, [canTestDestinations, schedules, runs, destinations]);

  return (
    <div className="space-y-8">
      {/* Faster while a run started here has not surfaced yet: that gap is the
          one the placeholder is covering. */}
      <AutoRefresh
        active={anythingRunning}
        intervalMs={pending.length > 0 ? 2_000 : 5_000}
      />
      <PageHeader
        level="section"
        docs="backups.overview"
        title="Backups"
        description={`Scheduled backups of this ${noun(target)} to a backup destination, and restore.`}
        actions={
          <BackUpMenu
            canManage={canManage}
            canRestore={canRestore}
            noDestinations={noDeps}
            onRunNow={() => setRunOpen(true)}
            onNewSchedule={() => setScheduleOpen(true)}
            onRestoreFromFile={() => setFileOpen(true)}
          />
        }
      />
      <BackUpNow
        target={target}
        destinations={destinations}
        canTestDestinations={canTestDestinations}
        open={runOpen}
        onOpenChange={setRunOpen}
        onStart={startRun}
      />
      <ScheduleBackup
        target={target}
        destinations={destinations}
        canTestDestinations={canTestDestinations}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
      />
      <RestoreFromFile
        target={target}
        open={fileOpen}
        onOpenChange={setFileOpen}
      />
      {/* Only the destinations THIS target writes to, so a page for one app
          never nags about a bucket it has nothing to do with. */}
      {unsavedKeyDestinations.map((d) => (
        <RecoveryKeyNudge
          key={d.id}
          destinationId={d.id}
          title={`Save the recovery key for ${d.name}`}
          description="These backups are encrypted. Without this key they cannot be read if you lose this instance."
          onSaved={() => router.refresh()}
        />
      ))}

      {/* Away on a target with nothing at all, so a new page is one empty state
          and not two stacked. */}
      {(schedules.length > 0 || runs.length > 0 || pending.length > 0) && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Schedules</h2>
          {schedules.length === 0 ? (
            <EmptyState
              graphic={<BackupScheduleGraphic />}
              title="No schedules yet"
              docs="backups.schedule"
              description={`Deplo can back this ${noun(target)} up on its own, on a schedule you pick.`}
            />
          ) : (
            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Destination</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Retention</TableHead>
                    <TableHead>Last run</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead className="text-right" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <OptimisticList>
                    {schedules.map((s) => (
                      <ScheduleRow
                        key={s.id}
                        schedule={s}
                        target={target}
                        destinations={destinations}
                        canManage={canManage}
                        canTestDestinations={canTestDestinations}
                        onStart={startRun}
                      />
                    ))}
                  </OptimisticList>
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Restore points</h2>
        {runs.length === 0 && pending.length === 0 ? (
          <EmptyState
            graphic={<BackupGraphic />}
            title="No backups yet"
            docs="backups.schedule"
            description="Run a backup or set up a schedule - completed runs and their restore points appear here."
          />
        ) : (
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Backup</TableHead>
                  <TableHead className="text-right">Size</TableHead>
                  <TableHead className="w-px" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map((p) => (
                  <PendingRunRow
                    key={p.id}
                    destinationName={
                      destName.get(p.destinationId) ?? "Unknown destination"
                    }
                    canRestore={canRestore}
                  />
                ))}
                <OptimisticList>
                  {runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      target={target}
                      canRestore={canRestore}
                      canDelete={canDelete}
                      canManage={canManage}
                      destinationName={
                        destName.get(run.destinationId) ?? "Unknown destination"
                      }
                    />
                  ))}
                </OptimisticList>
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
