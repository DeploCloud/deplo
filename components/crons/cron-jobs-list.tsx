"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  Plus,
  Timer,
  Trash2,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/shared/empty-state";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { CronJobDialog } from "@/components/crons/cron-job-dialog";
import { CronRunHistory } from "@/components/crons/cron-run-history";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { CronJobDTO } from "@/lib/data/crons";

/**
 * The operational Cron jobs page: what is scheduled, when each one runs next,
 * how the last one went, and the buttons that act on it.
 *
 * One row per job, expanding into its run history — the same shape the
 * Deployments list uses, because "what is scheduled" and "what happened" are the
 * same question asked at two zoom levels, and a separate page for the second one
 * would mean navigating away from the thing you are debugging.
 */

const RUN_NOW = /* GraphQL */ `
  mutation ($id: ID!) {
    runCronJobNow(id: $id) {
      id
      status
    }
  }
`;

const DELETE = /* GraphQL */ `
  mutation ($id: ID!) {
    deleteCronJob(id: $id)
  }
`;

/** The badge a job's last outcome gets. Grey for "nothing wrong happened". */
function LastStatus({ job }: { job: CronJobDTO }) {
  if (!job.lastStatus) {
    return <span className="text-xs text-muted-foreground">Never run</span>;
  }
  const map: Record<string, { variant: "success" | "destructive" | "warning" | "muted"; label: string }> = {
    succeeded: { variant: "success", label: "Succeeded" },
    failed: { variant: "destructive", label: "Failed" },
    timedout: { variant: "destructive", label: "Timed out" },
    // Grey, not red: nothing went wrong, it simply did not run.
    skipped: { variant: "muted", label: "Skipped" },
    lost: { variant: "warning", label: "Unknown" },
    running: { variant: "warning", label: "Running" },
  };
  const m = map[job.lastStatus] ?? { variant: "muted" as const, label: job.lastStatus };
  return (
    <SimpleTooltip content={job.lastRunAt ? `Last run ${timeAgo(job.lastRunAt)}` : "Last run"}>
      <Badge variant={m.variant} className="text-[10px] font-normal">
        {m.label}
      </Badge>
    </SimpleTooltip>
  );
}

function CronJobRow({
  job,
  targetKind,
  targetId,
  services,
  canManage,
}: {
  job: CronJobDTO;
  targetKind: "app" | "database";
  targetId: string;
  services: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [pending, startTransition] = React.useTransition();

  function runNow() {
    startTransition(async () => {
      const res = await gqlAction<{ runCronJobNow: { status: string } }>(RUN_NOW, {
        id: job.id,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The run can already be over by the time this returns — a stopped
      // container settles as `skipped` before the mutation answers — so report
      // what actually happened rather than "started".
      const status = res.data?.runCronJobNow.status;
      toast.success(
        status === "running" ? "Started" : status === "skipped" ? "Skipped" : "Finished",
      );
      setOpen(true);
      router.refresh();
    });
  }

  function remove() {
    startTransition(async () => {
      const res = await gqlAction(DELETE, { id: job.id });
      if (res.ok) {
        toast.success("Cron job deleted");
        setConfirmDelete(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <>
      <div className="rounded-lg border border-border">
        <div className="flex items-center gap-3 p-3">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
            aria-expanded={open}
          >
            <ChevronRight
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{job.name}</span>
                {!job.enabled && (
                  <Badge variant="muted" className="text-[10px] font-normal">
                    Disabled
                  </Badge>
                )}
                <LastStatus job={job} />
              </div>
              <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <ScheduleLabel cron={job.schedule} timezone={job.timezone} />
                {job.enabled && job.nextRunAt && (
                  <span>· next {timeAgo(job.nextRunAt)}</span>
                )}
                {job.service && <span className="font-mono">· {job.service}</span>}
              </p>
            </div>
          </button>
          {canManage && (
            <div className="flex shrink-0 items-center gap-1">
              <SimpleTooltip content="Run now">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={runNow}
                  disabled={pending}
                  aria-label={`Run ${job.name} now`}
                >
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                </Button>
              </SimpleTooltip>
              <SimpleTooltip content="Edit">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setEditing(true)}
                  aria-label={`Edit ${job.name}`}
                >
                  <Pencil className="size-4" />
                </Button>
              </SimpleTooltip>
              <SimpleTooltip content="Delete">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirmDelete(true)}
                  aria-label={`Delete ${job.name}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </SimpleTooltip>
            </div>
          )}
        </div>
        {open && (
          <div className="border-t border-border p-3">
            {job.description && (
              <p className="mb-3 text-sm text-muted-foreground">{job.description}</p>
            )}
            <pre className="mb-3 overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-xs">
              {job.command}
            </pre>
            <CronRunHistory jobId={job.id} canManage={canManage} />
          </div>
        )}
      </div>

      {/* Mounted only while open, so the dialog seeds its fields from `job` at
          mount and needs no prop-syncing effect. */}
      {editing && (
        <CronJobDialog
          open
          onOpenChange={setEditing}
          targetKind={targetKind}
          targetId={targetId}
          services={services}
          job={job}
        />
      )}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete &quot;{job.name}&quot;?</DialogTitle>
            <DialogDescription className="mt-1">
              Its run history goes with it. A run in flight is left to finish.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function CronJobsList({
  targetKind,
  targetId,
  enabled,
  jobs,
  services,
  canManage,
  settingsHref,
}: {
  targetKind: "app" | "database";
  targetId: string;
  enabled: boolean;
  jobs: CronJobDTO[];
  services: string[];
  canManage: boolean;
  /** Where the master switch lives, for the "it is off" empty state. */
  settingsHref: string;
}) {
  const [creating, setCreating] = React.useState(false);

  if (!enabled) {
    return (
      <EmptyState
        icon={Timer}
        title="Cron jobs are off"
        description="Turn them on in Settings to schedule a command inside this container."
        action={
          <Button asChild size="sm">
            <Link href={settingsHref}>Open settings</Link>
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Cron jobs</h2>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-4" />
            New cron job
          </Button>
        )}
      </div>

      {jobs.length === 0 ? (
        <EmptyState
          icon={Timer}
          title="No cron jobs yet"
          description="Schedule a command to run inside this container - a nightly cleanup, a queue worker, a report."
          action={
            canManage ? (
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-4" />
                New cron job
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {jobs.map((job) => (
              <CronJobRow
                key={job.id}
                job={job}
                targetKind={targetKind}
                targetId={targetId}
                services={services}
                canManage={canManage}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {creating && (
        <CronJobDialog
          open
          onOpenChange={setCreating}
          targetKind={targetKind}
          targetId={targetId}
          services={services}
        />
      )}
    </div>
  );
}
