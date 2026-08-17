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
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { EmptyState } from "@/components/shared/empty-state";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { CronGraphic } from "@/components/crons/cron-graphic";
import {
  OptimisticList,
  useOptimisticRow,
} from "@/components/shared/optimistic-list";
import { CronJobDialog } from "@/components/crons/cron-job-dialog";
import { CronRunHistory } from "@/components/crons/cron-run-history";
import { nextCronRunInZone } from "@/lib/crons/cron-tz";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { CronJobDTO } from "@/lib/data/crons";

/**
 * The operational Cron jobs page: what is scheduled, when each one runs next,
 * how the last one went, and the buttons that act on it.
 *
 * One row per job, expanding into its run history - the same shape the
 * Deployments list uses, because "what is scheduled" and "what happened" are the
 * same question asked at two zoom levels, and a separate page for the second one
 * would mean navigating away from the thing you are debugging.
 *
 * Everything with a clock in it is LIVE, and none of it is free-running: the
 * countdown is recomputed from the READER's clock every second (a "next run"
 * rendered on the server minutes ago ages into the past, which is how this page
 * came to say "next 45 seconds ago"), the row re-reads itself while a run is in
 * flight, and one re-read follows the soonest fire - the only change a page
 * rendered from job rows cannot otherwise see, because firing writes a run.
 */

/** How long after a fire the page re-reads to pick up the run it started: one
 *  scheduler tick to launch it, plus the reap that settles a quick command. */
const AFTER_FIRE_MS = 8_000;

const RUN_NOW = /* GraphQL */ `
  mutation ($id: ID!) {
    runCronJobNow(id: $id) {
      id
      status
      error
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
  // What it is doing NOW outranks how it went last time - and `lastStatus` can
  // never answer this, since it is written when a run settles.
  if (job.running) {
    return (
      <SimpleTooltip content="A run is in flight">
        <Badge variant="warning" className="text-[10px] font-normal">
          Running
        </Badge>
      </SimpleTooltip>
    );
  }
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
  nextRunAt,
  targetKind,
  targetId,
  services,
  canManage,
}: {
  job: CronJobDTO;
  /** The next fire, on the reader's clock. Null when the job is disabled. */
  nextRunAt: number | null;
  targetKind: "app" | "database";
  targetId: string;
  services: string[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const { hide, restore } = useOptimisticRow(job.id);
  const [pending, startTransition] = React.useTransition();
  // Bumped after a run starts: remounting the history is the immediate re-read
  // of a panel that is ALREADY open, which otherwise waits out its own poll
  // before showing the run the button just started.
  const [historyKey, setHistoryKey] = React.useState(0);

  function runNow() {
    startTransition(async () => {
      const res = await gqlAction<{
        runCronJobNow: { status: string; error: string | null };
      }>(RUN_NOW, { id: job.id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // The run can already be over by the time this returns - a stopped
      // container, or one the overlap rule skipped, settles before the mutation
      // answers - so report what actually happened rather than "started", and
      // for a skip say WHICH of the two it was, in the server's own words.
      const run = res.data?.runCronJobNow;
      if (run?.status === "skipped") {
        toast.warning(run.error ?? "Skipped");
      } else {
        toast.success(run?.status === "running" ? "Started" : "Finished");
      }
      setOpen(true);
      setHistoryKey((k) => k + 1);
      router.refresh();
    });
  }

  function remove() {
    // The row goes now and the delete settles behind it; the dialog closes in
    // the same commit rather than holding a spinner for a control-plane write.
    setConfirmDelete(false);
    hide();
    startTransition(async () => {
      const res = await gqlAction(DELETE, { id: job.id });
      if (res.ok) toast.success("Cron job deleted");
      else {
        restore();
        toast.error(res.error);
      }
      router.refresh();
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
                {/* The reader's clock, ticking - see the module header. The
                    server's first paint and the browser's can disagree by a
                    second at hydration, which is all `suppressHydrationWarning`
                    covers here. */}
                {nextRunAt !== null && (
                  <span suppressHydrationWarning>· next {timeAgo(nextRunAt)}</span>
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
            <CronRunHistory key={historyKey} jobId={job.id} canManage={canManage} />
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
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);

  // One ticker for the whole list: every time on this page is rendered from an
  // absolute instant, so a re-render is all it takes to keep them all honest.
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const nextRuns = jobs.map((j) =>
    j.enabled
      ? (nextCronRunInZone(j.schedule, new Date(now), j.timezone)?.getTime() ?? null)
      : null,
  );

  // The soonest fire ahead. When it rolls over, one has just happened - the one
  // change this page cannot see on its own, since firing writes a run row and
  // touches nothing a list of jobs is rendered from.
  //
  // ponytail: a fire is the only trigger, so a run somebody ELSE starts by hand
  //   on a page whose next fire is hours away waits for a reload. Upgrade: poll
  //   `appCronJobs` on a slow interval, which costs no RSC re-render.
  const soonest = Math.min(...nextRuns.filter((n): n is number => n !== null));
  const lastSoonest = React.useRef(soonest);
  React.useEffect(() => {
    const rolledOver = Number.isFinite(soonest) && lastSoonest.current !== soonest;
    lastSoonest.current = soonest;
    if (!rolledOver) return;
    const timer = setTimeout(() => router.refresh(), AFTER_FIRE_MS);
    return () => clearTimeout(timer);
  }, [soonest, router]);

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

  // One node, rendered in the header and again in the empty state - the same
  // shape the Pull requests page uses for its own pair. Two copies of the same
  // button are exactly how the two drifted apart in the first place.
  const newJobButton = canManage ? (
    <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
      New cron job
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      {/* The same heading shape as Pull requests and Environment next door: a
          section title inside the app, not a page title. */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium">Cron jobs</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Every job runs a command inside this container, on its own schedule
            and in its own timezone.
          </p>
        </div>
        {newJobButton}
      </div>

      {jobs.length === 0 ? (
        <EmptyState
          graphic={<CronGraphic />}
          title="No cron jobs yet"
          description="Schedule a command to run inside this container - a nightly cleanup, a queue worker, a report."
        />
      ) : (
        <Card>
          <CardContent className="space-y-2 pt-6">
            {/* A deleted job leaves the list on the click — the rows ask to be
                hidden themselves (see `OptimisticList`). */}
            <OptimisticList>
              {jobs.map((job, i) => (
                <CronJobRow
                  key={job.id}
                  job={job}
                  nextRunAt={nextRuns[i]}
                  targetKind={targetKind}
                  targetId={targetId}
                  services={services}
                  canManage={canManage}
                />
              ))}
            </OptimisticList>
          </CardContent>
        </Card>
      )}

      {/* Follow a run until it settles, then stop - an idle list costs nothing.
          Slower than the 5s default on purpose: a re-read here re-renders the
          whole app section, and its sidebar asks the owning agent whether this
          app has a files dir. The open row's own history polls faster. */}
      <AutoRefresh active={jobs.some((j) => j.running)} intervalMs={10_000} />

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
