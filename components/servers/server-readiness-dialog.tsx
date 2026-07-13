"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Hourglass,
  Info,
  ListChecks,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/**
 * The readiness REPORT for one server: a live, never-stored answer to "is this
 * host's installation complete enough to deploy Apps to?".
 *
 * Distinct from the health chip on the card, which answers "can we reach and
 * trust this agent right now?". Opening this dialog dials the owning agent once
 * (Hello + two host-port bind tests + host metrics) and renders what came back,
 * grouped and severity-ranked. Nothing is persisted, which is why this component
 * deliberately does NOT call `router.refresh()` after a run: the check writes
 * nothing, so a refresh would re-run every read on the page to learn nothing —
 * and, worse, would suggest the page's stored status had been touched. It hasn't.
 *
 * The probe runs on open and on every "Run again"; a `runId` ref discards a
 * response that a newer run (or a reopen) has already superseded.
 */

/* ------------------------------------------------------------------ */
/* Wire types                                                          */
/* ------------------------------------------------------------------ */

/**
 * Declared LOCALLY on purpose, mirroring `server-health-provider.tsx`. The
 * canonical types live in `lib/infra/server-readiness.ts`, but that module
 * imports `./agent-client` — which is `import "server-only"` and pulls in
 * `@grpc/grpc-js` — so naming it from a client component would drag the agent
 * client into the browser bundle and break the build. These mirror the SDL of
 * `ServerReadinessReport`, which is the contract that actually crosses the wire.
 */
type ReadinessSeverity = "pass" | "info" | "warn" | "fail" | "skip";
type ReadinessGroup = "agent" | "docker" | "routing" | "capacity" | "build" | "config";
type ReadinessVerdict = "ready" | "degraded" | "not_ready" | "provisioning";

interface ReadinessCheckRow {
  id: string;
  group: ReadinessGroup;
  label: string;
  severity: ReadinessSeverity;
  detail: string;
  hint: string | null;
}

interface ReadinessReportRow {
  serverId: string;
  serverName: string;
  checkedAt: string;
  verdict: ReadinessVerdict;
  summary: string;
  checks: ReadinessCheckRow[];
}

const CHECK_READINESS = /* GraphQL */ `
  mutation CheckServerReadiness($id: String!) {
    checkServerReadiness(id: $id) {
      serverId
      serverName
      checkedAt
      verdict
      summary
      checks {
        id
        group
        label
        severity
        detail
        hint
      }
    }
  }
`;

/* ------------------------------------------------------------------ */
/* Presentation tables                                                 */
/* ------------------------------------------------------------------ */

const VERDICT_META: Record<
  ReadinessVerdict,
  { icon: React.ComponentType<{ className?: string }>; label: string; box: string; tone: string }
> = {
  ready: {
    icon: CircleCheck,
    label: "Ready to deploy",
    box: "border-[var(--success)]/30 bg-[var(--success)]/10",
    tone: "text-[var(--success)]",
  },
  degraded: {
    icon: TriangleAlert,
    label: "Deployable, with warnings",
    box: "border-[var(--warning)]/30 bg-[var(--warning)]/10",
    tone: "text-[var(--warning)]",
  },
  not_ready: {
    icon: CircleX,
    label: "Not ready to deploy",
    box: "border-destructive/30 bg-destructive/10",
    tone: "text-destructive",
  },
  provisioning: {
    icon: Hourglass,
    label: "Still provisioning",
    box: "border-border bg-muted/30",
    tone: "text-muted-foreground",
  },
};

const SEVERITY_META: Record<
  ReadinessSeverity,
  { icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  pass: { icon: CircleCheck, tone: "text-[var(--success)]" },
  info: { icon: Info, tone: "text-muted-foreground" },
  warn: { icon: TriangleAlert, tone: "text-[var(--warning)]" },
  fail: { icon: CircleX, tone: "text-destructive" },
  skip: { icon: CircleHelp, tone: "text-muted-foreground/70" },
};

/** The counts row: only non-zero counts render, worst first. */
const COUNTS: readonly {
  severity: ReadinessSeverity;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
}[] = [
  { severity: "fail", label: "failed", icon: CircleX, tone: "text-destructive" },
  {
    severity: "warn",
    label: "warnings",
    icon: TriangleAlert,
    tone: "text-[var(--warning)]",
  },
  { severity: "skip", label: "skipped", icon: CircleHelp, tone: "text-muted-foreground" },
  { severity: "pass", label: "passed", icon: CircleCheck, tone: "text-[var(--success)]" },
];

const GROUP_ORDER: readonly ReadinessGroup[] = [
  "agent",
  "docker",
  "routing",
  "capacity",
  "build",
  "config",
];

const GROUP_LABELS: Record<ReadinessGroup, string> = {
  agent: "Agent",
  docker: "Docker",
  routing: "Routing",
  capacity: "Host capacity",
  build: "Build methods",
  config: "Deplo configuration",
};

/**
 * The honest caveats. They live in a tooltip, not as helper text under the rows
 * (the repo's field-help rule), because they qualify what the whole group can and
 * cannot prove — a reader only needs them when they doubt a row.
 */
const GROUP_INFO: Partial<Record<ReadinessGroup, string>> = {
  routing:
    'Deplo looks for a running container whose image or name contains "traefik", and bind-tests ports 80 and 443 on the host. It cannot tell whether that container is the one it installed.',
  capacity:
    "Measured on the host's root filesystem — the one the agent runs from. If Docker's images live on a separate volume, this does not describe it.",
  build:
    "Supported means this server's agent knows how to run the build method. The images and binaries it needs are fetched on the first build that uses it — Deplo cannot check from here that they are already on the host.",
};

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

export function ServerReadinessDialog({
  serverId,
  serverName,
  open,
  onOpenChange,
}: {
  serverId: string;
  serverName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const runId = React.useRef(0);
  const [loading, setLoading] = React.useState(false);
  const [report, setReport] = React.useState<ReadinessReportRow | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  /**
   * `reset` drops the previous report before probing. The OPEN path passes it (the
   * dialog must never paint an answer collected before it was opened); "Run again"
   * does not, so the rows stay on screen while the fresh probe runs. It lives here
   * rather than in the effect body because a setState called straight from an effect
   * is a cascading render (react-hooks/set-state-in-effect).
   */
  const run = React.useCallback((opts?: { reset?: boolean }) => {
    const id = ++runId.current;
    if (opts?.reset) setReport(null);
    setLoading(true);
    setError(null);
    (async () => {
      const res = await gqlAction<{ checkServerReadiness: ReadinessReportRow }>(
        CHECK_READINESS,
        { id: serverId },
      );
      // A newer run — or a reopen — superseded this one; its answer is stale.
      if (id !== runId.current) return;
      setLoading(false);
      if (!res.ok) {
        // The server's message, verbatim (e.g. "Server not found").
        setError(res.error);
        toast.error(res.error);
        return;
      }
      if (!res.data) return;
      setReport(res.data.checkServerReadiness);
    })();
  }, [serverId]);

  React.useEffect(() => {
    if (!open) return;
    // Opening the dialog IS the probe — it synchronises with an external system (the
    // owning server's agent), and `run` manages its own state. Same shape, and the
    // same scoped exemption, as the repo-picker's load-on-change effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    run({ reset: true });
  }, [open, run]);

  const verdict = report ? VERDICT_META[report.verdict] : null;
  const VerdictIcon = verdict?.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-4" />
            Deploy readiness for {serverName}
          </DialogTitle>
          <DialogDescription>
            A live look at what this server can actually do: Deplo dials the agent,
            asks the host what it can see, and lists what it found. Nothing is
            stored — re-run it whenever you like.
          </DialogDescription>
        </DialogHeader>

        {/* On a re-run the previous report stays below this banner: a probe that is
            still in flight has nothing better to show, and blanking the rows would
            throw away the answer the operator is comparing against. */}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking {serverName}…
          </div>
        ) : null}

        {error ? <p className="py-6 text-sm text-destructive">{error}</p> : null}

        {report && verdict && VerdictIcon ? (
          <div className="space-y-4">
            <div
              className={cn("flex items-start gap-2 rounded-lg border p-3", verdict.box)}
            >
              <VerdictIcon
                className={cn("mt-0.5 size-4 shrink-0", verdict.tone)}
                aria-hidden
              />
              <div className="min-w-0">
                <p className={cn("text-sm font-medium", verdict.tone)}>{verdict.label}</p>
                <p className="text-xs text-muted-foreground">{report.summary}</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {COUNTS.map(({ severity, label, icon: Icon, tone }) => {
                const n = report.checks.filter((c) => c.severity === severity).length;
                if (n === 0) return null;
                return (
                  <span
                    key={severity}
                    className={cn("flex items-center gap-1 text-xs font-medium", tone)}
                  >
                    <Icon className="size-3.5" aria-hidden />
                    {n} {label}
                  </span>
                );
              })}
            </div>

            <div className="space-y-4">
              {GROUP_ORDER.map((g) => {
                const rows = report.checks.filter((c) => c.group === g);
                if (rows.length === 0) return null;
                const info = GROUP_INFO[g];
                return (
                  <div key={g} className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {GROUP_LABELS[g]}
                      </h4>
                      {info ? <InfoTip content={info} /> : null}
                    </div>
                    <ul className="space-y-1.5">
                      {rows.map((c) => {
                        const Icon = SEVERITY_META[c.severity].icon;
                        return (
                          <li
                            key={c.id}
                            className="flex items-start gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5"
                          >
                            <Icon
                              className={cn(
                                "mt-0.5 size-4 shrink-0",
                                SEVERITY_META[c.severity].tone,
                              )}
                              aria-hidden
                            />
                            <div className="min-w-0">
                              <p className="text-xs font-medium">{c.label}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {c.detail}
                              </p>
                              {c.hint ? (
                                <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                                  {c.hint}
                                </p>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => run()} disabled={loading}>
            <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            {loading ? "Checking…" : "Run again"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
