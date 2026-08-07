"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Square } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gql, gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { CronRunDTO } from "@/lib/data/crons";

/**
 * One job's run history, fetched when its row is expanded.
 *
 * Client-fetched rather than server-rendered with the list: a job's history is
 * the detail behind a row nobody has opened yet, and loading every job's runs to
 * render a page that shows none of them would be the expensive half of the query
 * done for nothing.
 *
 * Six statuses, and the copy is where the distinctions pay off. `skipped` and
 * `lost` are not failures - one never started, the other has an unknown outcome
 * - so neither is painted red, and each says which in a sentence rather than
 * leaving the reader to infer it from a colour.
 */

const RUNS = /* GraphQL */ `
  query ($jobId: ID!) {
    cronRuns(jobId: $jobId, limit: 20) {
      id
      status
      trigger
      actor
      startedAt
      finishedAt
      attempt
      maxAttempts
      retrying
      exitCode
      stdout
      stderr
      error
      container
    }
  }
`;

const CANCEL = /* GraphQL */ `
  mutation ($id: ID!) {
    cancelCronRun(id: $id)
  }
`;

const STATUS: Record<
  string,
  { variant: "success" | "destructive" | "warning" | "muted"; label: string; note?: string }
> = {
  running: { variant: "warning", label: "Running" },
  succeeded: { variant: "success", label: "Succeeded" },
  failed: { variant: "destructive", label: "Failed" },
  timedout: {
    variant: "destructive",
    label: "Timed out",
    note: "Stopped at the job's timeout. Raise it under Advanced if the command legitimately takes this long.",
  },
  skipped: {
    variant: "muted",
    label: "Skipped",
    note: "This run never started, so nothing failed.",
  },
  lost: {
    variant: "warning",
    label: "Unknown",
    note: "Deplo lost track of this run when the server's agent restarted. The command may or may not have completed.",
  },
};

function RunRow({ run, canManage, onChanged }: {
  run: CronRunDTO;
  canManage: boolean;
  onChanged: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const meta = STATUS[run.status] ?? { variant: "muted" as const, label: run.status };
  const output = [run.stdout, run.stderr].filter(Boolean).join("\n");

  function cancel() {
    startTransition(async () => {
      const res = await gqlAction(CANCEL, { id: run.id });
      if (res.ok) {
        toast.success("Run stopped");
        onChanged();
        router.refresh();
      } else toast.error(res.error);
    });
  }

  return (
    <div className="rounded-md border border-border">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <Badge variant={meta.variant} className="shrink-0 text-[10px] font-normal">
            {run.retrying ? "Retrying" : meta.label}
          </Badge>
          <span className="truncate text-xs text-muted-foreground">
            {timeAgo(run.startedAt)}
            {run.trigger === "manual" ? ` · by ${run.actor}` : ""}
            {run.attempt > 0 ? ` · attempt ${run.attempt + 1} of ${run.maxAttempts}` : ""}
            {run.exitCode != null && run.status !== "running" ? ` · exit ${run.exitCode}` : ""}
          </span>
        </button>
        {canManage && run.status === "running" && (
          <SimpleTooltip content="Stop this run">
            <Button
              variant="ghost"
              size="icon"
              onClick={cancel}
              disabled={pending}
              aria-label="Stop this run"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-4" />
              )}
            </Button>
          </SimpleTooltip>
        )}
      </div>
      {open && (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {/* The sentence a colour cannot carry: why this is not a failure. */}
          {meta.note && <p className="text-xs text-muted-foreground">{meta.note}</p>}
          {run.error && <p className="text-xs text-muted-foreground">{run.error}</p>}
          {run.attempt > 0 && (
            <p className="text-xs text-muted-foreground">
              Showing the last of {run.attempt + 1} attempts.
            </p>
          )}
          {output ? (
            <pre className="max-h-80 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-xs">
              {output}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">
              {run.status === "running" ? "Output appears when the run ends." : "No output."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function CronRunHistory({
  jobId,
  canManage,
}: {
  jobId: string;
  canManage: boolean;
}) {
  const [runs, setRuns] = React.useState<CronRunDTO[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    let cancelled = false;
    gql<{ cronRuns: CronRunDTO[] }>(RUNS, { jobId })
      .then((d) => {
        if (!cancelled) setRuns(d.cronRuns);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load runs");
      });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  React.useEffect(load, [load]);

  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (!runs) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Loading runs
      </p>
    );
  }
  if (runs.length === 0) {
    return <p className="text-xs text-muted-foreground">This job has not run yet.</p>;
  }
  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} canManage={canManage} onChanged={load} />
      ))}
    </div>
  );
}
