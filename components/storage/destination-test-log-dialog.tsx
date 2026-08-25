"use client";

import * as React from "react";
import { Check, CircleDashed, Loader2, PlugZap, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/shared/code-block";
import { LogLines, LogRow } from "@/components/shared/log-line-row";
import { cn, timeAgo } from "@/lib/utils";
import { gql } from "@/lib/graphql-client";
import type { LogLevel } from "@/lib/types";

/** Mirror of the GraphQL `S3TestReport` shape (see lib/data/s3-test-report.ts). */
export type S3TestReportView = {
  ok: boolean;
  never: boolean;
  error: string;
  startedAt: string;
  durationMs: number;
  serverName: string;
  steps: {
    key: string;
    label: string;
    detail: string;
    status: "passed" | "failed" | "skipped";
  }[];
  lines: { level: string; text: string }[];
  command: string;
};

export const S3_TEST_REPORT_FIELDS = `
  ok never error startedAt durationMs serverName
  steps { key label detail status }
  lines { level text }
  command
`;

/**
 * The full debug output of a destination's "Test connection": the verdict, the
 * probe sequence with the step it stopped at, the agent's verbatim message, and
 * the commands that reproduce the same calls by hand.
 */
export function DestinationTestLogDialog({
  open,
  onOpenChange,
  destinationId,
  destinationName,
  onTested,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  destinationId: string;
  destinationName: string;
  /** Called after a re-run so the card's badge can follow the new verdict. */
  onTested?: (report: S3TestReportView) => void;
}) {
  const [report, setReport] = React.useState<S3TestReportView | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  // A failed RE-RUN is shown ABOVE the report, not instead of it: losing the log
  // you opened because the retry could not reach the server is the wrong trade.
  const [runError, setRunError] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);

  // Load the stored report on each open so it reflects a test run from the card
  // meanwhile. Aborts if the dialog closes mid-flight; the reset happens on
  // CLOSE, so re-opening shows the spinner rather than the previous verdict.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    gql<{ destinationTestReport: S3TestReportView }>(
      `query ($id: String!) { destinationTestReport(id: $id) { ${S3_TEST_REPORT_FIELDS} } }`,
      { id: destinationId },
      controller.signal,
    )
      .then((d) => setReport(d.destinationTestReport))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(e instanceof Error ? e.message : "Failed to load the log");
      });
    return () => controller.abort();
  }, [open, destinationId]);

  function handleOpenChange(v: boolean) {
    if (!v) {
      setReport(null);
      setLoadError(null);
      setRunError(null);
    }
    onOpenChange(v);
  }

  function runAgain() {
    setRunning(true);
    setRunError(null);
    gql<{ testDestination: { report: S3TestReportView } }>(
      `mutation ($id: String!) { testDestination(id: $id) { report { ${S3_TEST_REPORT_FIELDS} } } }`,
      { id: destinationId },
    )
      .then((d) => {
        setReport(d.testDestination.report);
        onTested?.(d.testDestination.report);
      })
      .catch((e: unknown) =>
        setRunError(e instanceof Error ? e.message : "The test could not run"),
      )
      .finally(() => setRunning(false));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Connection log</DialogTitle>
          <DialogDescription>
            Everything deplo checked on {destinationName}, in order, with the
            answer it got back.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[65vh] space-y-5 overflow-y-auto">
          {loadError ? (
            <p className="text-sm text-destructive">{loadError}</p>
          ) : report === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading the last test
            </div>
          ) : (
            <>
              {runError && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                  {runError}
                </p>
              )}
              <Verdict report={report} />
              {report.steps.length > 0 && <Steps steps={report.steps} />}
              <Section title="Full output">
                <LogLines className="max-h-72 rounded-lg border border-border">
                  {report.lines.map((l, i) => (
                    <LogRow key={i} level={l.level as LogLevel} text={l.text} />
                  ))}
                </LogLines>
              </Section>
              <Section
                title="Reproduce this check"
                hint="deplo runs it inside the server's agent — these are the same calls for a shell"
              >
                <CodeBlock code={report.command} />
              </Section>
            </>
          )}
        </div>

        <DialogFooter>
          <Button size="sm" onClick={runAgain} disabled={running}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlugZap className="size-4" />
            )}
            {report?.never ? "Test connection" : "Test again"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Verdict badge + the four facts that frame the log. */
function Verdict({ report }: { report: S3TestReportView }) {
  const facts: { label: string; value: string }[] = [
    {
      label: "Ran on",
      value: report.serverName || "no server answered",
    },
    {
      label: "When",
      value: report.startedAt ? timeAgo(report.startedAt) : "never",
    },
    {
      label: "Took",
      value: report.durationMs
        ? `${(report.durationMs / 1000).toFixed(2)}s`
        : "—",
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-border bg-secondary/40 p-4">
      <div>
        <p className="text-xs text-muted-foreground">Result</p>
        <Badge
          variant={
            report.never ? "warning" : report.ok ? "success" : "destructive"
          }
          className="mt-1"
        >
          {report.never ? "Not tested yet" : report.ok ? "Reachable" : "Failed"}
        </Badge>
      </div>
      {!report.never &&
        facts.map((f) => (
          <div key={f.label}>
            <p className="text-xs text-muted-foreground">{f.label}</p>
            <p className="mt-1 text-sm">{f.value}</p>
          </div>
        ))}
    </div>
  );
}

const STEP_ICON = {
  passed: Check,
  failed: X,
  skipped: CircleDashed,
} as const;

const STEP_CLASS = {
  passed: "text-[var(--success)]",
  failed: "text-destructive",
  skipped: "text-muted-foreground",
} as const;

/** The probe sequence, so "where did it break" is answerable at a glance. */
function Steps({ steps }: { steps: S3TestReportView["steps"] }) {
  return (
    <Section title="What deplo checked">
      <ol className="space-y-2">
        {steps.map((s) => {
          const Icon = STEP_ICON[s.status];
          return (
            <li key={s.key} className="flex items-start gap-3">
              <Icon
                className={cn("mt-0.5 size-4 shrink-0", STEP_CLASS[s.status])}
              />
              <div className="min-w-0">
                <p
                  className={cn(
                    "text-sm",
                    s.status === "skipped" && "text-muted-foreground",
                  )}
                >
                  {s.label}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {s.detail}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Section>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          {title}
        </p>
        {hint && <p className="text-xs text-muted-foreground/70">{hint}</p>}
      </div>
      {children}
    </div>
  );
}
