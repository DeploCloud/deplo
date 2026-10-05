"use client";

import * as React from "react";
import {
  Box,
  CircleCheck,
  CircleDashed,
  CircleX,
  Database,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import type {
  MoveStatus,
  MoveStatusStepKey,
  MoveStatusStepState,
} from "@/lib/data/deplo-move/target";
import type { MoveWorkloadState } from "@/lib/deplo-move/protocol";
import { cn } from "@/lib/utils";
import { PeerLink } from "./peer-link";

// What the public progress page knows about a move: no name of whoever started it.
export type MoveView = Omit<MoveStatus, "startedBy">;

const STATUS_FIELDS = `
  id
  state
  error
  peerUrl
  setupPath
  rowsCopied
  unreadable
  createdAt
  finishedAt
  canRetry
  canCancel
  canFinishWithoutSource
  canSkip
  needsAdminSignIn
  steps {
    key
    state
  }
  servers {
    id
    name
    targetId
    targetName
  }
  workloads {
    kind
    id
    name
    state
    error
  }
`;

const DEPLO_MOVE_STATUS = /* GraphQL */ `
  query DeploMoveStatus($id: String!) {
    deploMoveStatus(id: $id) {
      ${STATUS_FIELDS}
    }
  }
`;

const RETRY_DEPLO_MOVE = /* GraphQL */ `
  mutation RetryDeploMove($id: String!) {
    retryDeploMove(id: $id) {
      ${STATUS_FIELDS}
    }
  }
`;

const CANCEL_DEPLO_MOVE = /* GraphQL */ `
  mutation CancelDeploMove($id: String!) {
    cancelDeploMove(id: $id) {
      ${STATUS_FIELDS}
    }
  }
`;

const FINISH_WITHOUT_SOURCE = /* GraphQL */ `
  mutation FinishDeploMoveWithoutSource($id: String!) {
    finishDeploMoveWithoutSource(id: $id) {
      ${STATUS_FIELDS}
    }
  }
`;

const SKIP_WORKLOAD = /* GraphQL */ `
  mutation SkipDeploMoveWorkload(
    $id: String!
    $kind: DeploMoveWorkloadKind!
    $workloadId: String!
  ) {
    skipDeploMoveWorkload(id: $id, kind: $kind, workloadId: $workloadId) {
      ${STATUS_FIELDS}
    }
  }
`;

const POLL_MS = 2_000;

const TITLE: Record<MoveView["state"], string> = {
  connected: "Ready to move",
  copying: "Moving Deplo",
  deploying: "Moving Deplo",
  failed: "The move stopped",
  done: "Moved",
  cancelled: "Move cancelled",
};

const STEP_LABEL: Record<MoveStatusStepKey, string> = {
  copy: "Copy everything",
  deploy: "Deploy and copy data",
  finish: "Finish",
};

const WORKLOAD_LABEL: Record<MoveWorkloadState, string> = {
  waiting: "Waiting",
  copying: "Copying",
  done: "Copied",
  failed: "Failed",
  skipped: "Left out",
};

export function MoveProgress({ initial }: { initial: MoveView }) {
  const [status, setStatus] = React.useState(initial);
  const [retrying, startRetry] = React.useTransition();
  const { id, state } = status;
  const live = state !== "done" && state !== "cancelled";

  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(async () => {
      const res = await gqlAction<{ deploMoveStatus: MoveView | null }>(
        DEPLO_MOVE_STATUS,
        { id },
      );
      if (res.ok && res.data?.deploMoveStatus)
        setStatus(res.data.deploMoveStatus);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, id]);

  function retry() {
    startRetry(async () => {
      const res = await gqlAction<{ retryDeploMove: MoveView }>(
        RETRY_DEPLO_MOVE,
        { id },
      );
      if (!res.ok) toast.error(res.error);
      else if (res.data) setStatus(res.data.retryDeploMove);
    });
  }

  async function cancel() {
    const res = await gqlAction<{ cancelDeploMove: MoveView }>(
      CANCEL_DEPLO_MOVE,
      { id },
    );
    if (res.ok && res.data) setStatus(res.data.cancelDeploMove);
    return res;
  }

  async function skip(w: MoveView["workloads"][number]) {
    const res = await gqlAction<{ skipDeploMoveWorkload: MoveView }>(
      SKIP_WORKLOAD,
      { id, kind: w.kind, workloadId: w.id },
    );
    if (res.ok && res.data) setStatus(res.data.skipDeploMoveWorkload);
    return res;
  }

  async function finishWithoutSource() {
    const res = await gqlAction<{ finishDeploMoveWithoutSource: MoveView }>(
      FINISH_WITHOUT_SOURCE,
      { id },
    );
    if (res.ok && res.data) setStatus(res.data.finishDeploMoveWithoutSource);
    return res;
  }

  const peer = <PeerLink url={status.peerUrl} />;

  return (
    <div className="deplo-stagger space-y-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {TITLE[state]}
        </h1>
        <p className="mt-1 text-sm text-balance text-muted-foreground">
          {state === "done" ? (
            <>
              Everything from {peer} runs here now. The old Deplo keeps running
              too, until you retire it.
            </>
          ) : state === "cancelled" ? (
            <>Nothing was moved from {peer}, and it kept running.</>
          ) : state === "failed" ? (
            <>From {peer}. Nothing is lost: fix what it says, then try again.</>
          ) : state === "connected" ? (
            <>From {peer}. It has not started yet.</>
          ) : state === "deploying" ? (
            <>From {peer}. Apps here may restart while their data copies.</>
          ) : (
            <>From {peer}. You can close this page: the move keeps going.</>
          )}{" "}
          <DocsLink topic="deplo.move" />
        </p>
      </div>

      {state !== "cancelled" && (
        <Steps status={status} onSkip={status.canSkip ? skip : undefined} />
      )}

      {status.error && state === "failed" && (
        <Note tone="destructive">{status.error}</Note>
      )}
      {status.error && (state === "cancelled" || state === "done") && (
        <Note tone="warning">{status.error}</Note>
      )}
      {state === "done" && status.unreadable > 0 && (
        <Note tone="warning">
          {status.unreadable === 1
            ? "1 saved secret could not be read on the old Deplo and needs to be entered again."
            : `${status.unreadable} saved secrets could not be read on the old Deplo and need to be entered again.`}
        </Note>
      )}

      {state === "done" && (
        <div className="space-y-2 text-center">
          <Button asChild>
            <Link href="/login">Sign in</Link>
          </Button>
          <p className="text-sm text-muted-foreground">
            Use the account you had on <PeerLink url={status.peerUrl} />.
          </p>
        </div>
      )}

      {state === "cancelled" && (
        <div className="flex justify-center">
          <Button asChild>
            {status.setupPath ? (
              <Link href={status.setupPath}>Set up this Deplo</Link>
            ) : (
              <Link href="/">Back to dashboard</Link>
            )}
          </Button>
        </div>
      )}

      {(status.canCancel ||
        status.canRetry ||
        status.canFinishWithoutSource) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {status.canCancel && (
            <ConfirmAction
              trigger={<Button variant="outline">Cancel move</Button>}
              title="Cancel the move?"
              description="The old Deplo starts anything it paused and carries on as before."
              consequence={
                state === "connected"
                  ? undefined
                  : "Everything copied or deployed here is deleted, and this Deplo has to be set up again."
              }
              confirmLabel="Cancel move"
              onConfirm={cancel}
            />
          )}
          {status.canFinishWithoutSource && (
            <ConfirmAction
              trigger={
                <Button variant="outline">Finish without the old Deplo</Button>
              }
              title="Finish without the old Deplo?"
              description={
                <>
                  Only if the old Deplo is <strong>gone for good</strong>: this
                  Deplo keeps everything copied so far.
                </>
              }
              consequence="Apps and databases whose data never came across are left out, not deployed."
              confirmLabel="Finish move"
              onConfirm={finishWithoutSource}
            />
          )}
          {status.canRetry && (
            <Button onClick={retry} disabled={retrying}>
              {retrying && <Loader2 className="size-4 animate-spin" />}
              Try again
            </Button>
          )}
        </div>
      )}

      {status.needsAdminSignIn && (
        <p className="text-center text-sm text-muted-foreground">
          <Link href="/login" className="font-medium text-foreground underline">
            Sign in
          </Link>{" "}
          as an instance admin of <PeerLink url={status.peerUrl} /> to cancel,
          skip or finish.
        </p>
      )}
    </div>
  );
}

type Workload = MoveView["workloads"][number];

function Steps({
  status,
  onSkip,
}: {
  status: MoveView;
  onSkip?: (w: Workload) => Promise<ActionResult<unknown>>;
}) {
  const copied = status.workloads.filter((w) => w.state === "done");
  return (
    <ol className="divide-y divide-border rounded-xl border border-border bg-card">
      {status.steps.map((step) => (
        <li key={step.key} className="px-4 py-3">
          <div className="flex items-center gap-3 text-sm">
            <StepIcon state={step.state} />
            <span
              className={cn(
                "font-medium",
                step.state === "waiting" && "text-muted-foreground",
              )}
            >
              {STEP_LABEL[step.key]}
            </span>
            {step.key === "deploy" && status.workloads.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {copied.length} of {status.workloads.length}
              </span>
            )}
          </div>
          {step.key === "deploy" && status.workloads.length > 0 && (
            <ul className="mt-2 ml-7 space-y-1.5">
              {status.workloads.map((w) => (
                <WorkloadRow
                  key={`${w.kind}:${w.id}`}
                  workload={w}
                  onSkip={
                    onSkip && w.state === "failed" ? () => onSkip(w) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

function WorkloadRow({
  workload: w,
  onSkip,
}: {
  workload: Workload;
  onSkip?: () => Promise<ActionResult<unknown>>;
}) {
  const Icon = w.kind === "database" ? Database : Box;
  return (
    <li className="text-sm">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{w.name}</span>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 text-xs",
            w.state === "done" && "text-success",
            w.state === "failed" && "text-destructive",
            w.state === "skipped" && "text-warning",
            (w.state === "waiting" || w.state === "copying") &&
              "text-muted-foreground",
          )}
        >
          {w.state === "copying" && <Loader2 className="size-3 animate-spin" />}
          {WORKLOAD_LABEL[w.state]}
        </span>
        {onSkip && (
          <ConfirmAction
            trigger={
              <Button variant="link" size="sm" className="h-auto p-0 text-xs">
                Skip
              </Button>
            }
            title={`Skip ${w.name}?`}
            description="The move goes on without it."
            consequence="It is left out of this Deplo: add it again by hand."
            confirmLabel="Skip"
            onConfirm={onSkip}
          />
        )}
      </div>
      {w.error && (
        <p
          className={cn(
            "mt-0.5 ml-5.5 text-xs",
            w.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {w.error}
        </p>
      )}
    </li>
  );
}

function StepIcon({ state }: { state: MoveStatusStepState }) {
  if (state === "running")
    return <Loader2 className="size-4 shrink-0 animate-spin text-primary" />;
  if (state === "done")
    return <CircleCheck className="size-4 shrink-0 text-success" />;
  if (state === "failed")
    return <CircleX className="size-4 shrink-0 text-destructive" />;
  return <CircleDashed className="size-4 shrink-0 text-muted-foreground" />;
}

function Note({
  tone,
  children,
}: {
  tone: "destructive" | "warning";
  children: React.ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        tone === "destructive"
          ? "border-destructive/40 bg-destructive-wash text-destructive"
          : "border-warning/40 bg-warning-wash text-warning",
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
