"use client";

import * as React from "react";
import {
  CircleCheck,
  CircleDashed,
  CircleX,
  Loader2,
  Server as ServerIcon,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type {
  MoveStatus,
  MoveStatusStepKey,
  MoveStatusStepState,
} from "@/lib/data/deplo-move/target";
import type { MoveServerState } from "@/lib/deplo-move/protocol";
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
  steps {
    key
    state
  }
  servers {
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

const POLL_MS = 2_000;

const TITLE: Record<MoveView["state"], string> = {
  connected: "Ready to move",
  copying: "Moving Deplo",
  handing_over: "Moving Deplo",
  failed: "The move stopped",
  done: "Moved",
  cancelled: "Move cancelled",
};

const STEP_LABEL: Record<MoveStatusStepKey, string> = {
  copy: "Copy everything",
  servers: "Hand over servers",
  finish: "Finish",
};

const SERVER_LABEL: Record<MoveServerState, string> = {
  waiting: "Waiting",
  handed_over: "Handed over",
  failed: "Failed",
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
            <>This Deplo now runs everything from {peer}.</>
          ) : state === "cancelled" ? (
            <>Nothing was moved from {peer}.</>
          ) : state === "failed" ? (
            <>From {peer}. Nothing is lost: fix what it says, then try again.</>
          ) : state === "connected" ? (
            <>From {peer}. It has not started yet.</>
          ) : (
            <>From {peer}. You can close this page: the move keeps going.</>
          )}{" "}
          <DocsLink topic="deplo.move" />
        </p>
      </div>

      {state !== "cancelled" && <Steps status={status} />}

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
              description="The old Deplo takes changes again, and no server is handed over."
              consequence={
                state === "connected"
                  ? undefined
                  : "Anything already copied here is deleted, and this Deplo has to be set up again."
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
              consequence="Servers not handed over yet stay with the old Deplo and must be added here again."
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
    </div>
  );
}

function Steps({ status }: { status: MoveView }) {
  const finished = status.state === "done";
  const handed = status.servers.filter((s) => s.state === "handed_over");
  // The first server still waiting is the one being handed over right now.
  const current =
    status.state === "handing_over"
      ? status.servers.find((s) => s.state === "waiting")?.id
      : undefined;
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
            {step.key === "servers" && status.servers.length > 0 && (
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {handed.length} of {status.servers.length}
              </span>
            )}
          </div>
          {step.key === "servers" && status.servers.length > 0 && (
            <ul className="mt-2 ml-7 space-y-1.5">
              {status.servers.map((s) => (
                <li key={s.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{s.name}</span>
                    <span
                      className={cn(
                        "ml-auto flex shrink-0 items-center gap-1 text-xs",
                        s.state === "handed_over" && "text-success",
                        s.state === "failed" && "text-destructive",
                        s.state === "waiting" && "text-muted-foreground",
                      )}
                    >
                      {s.id === current && (
                        <Loader2 className="size-3 animate-spin" />
                      )}
                      {s.id === current
                        ? "Handing over"
                        : finished && s.state === "failed"
                          ? "Left behind"
                          : SERVER_LABEL[s.state]}
                    </span>
                  </div>
                  {s.error && (
                    <p
                      className={cn(
                        "mt-0.5 ml-5.5 text-xs",
                        s.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {s.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
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
