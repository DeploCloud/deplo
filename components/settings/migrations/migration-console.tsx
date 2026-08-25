"use client";

import * as React from "react";
import {
  ArrowDownToLine,
  Check,
  Search,
  SkipForward,
  TriangleAlert,
  Info,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { gql } from "@/lib/graphql-client";
import type { ReportItem } from "./types";

/**
 * What a migration is doing, line by line, while it does it.
 *
 * It replaces a dialog that listed the same rows in prose and told nobody
 * anything: no times, no way to find the one service you care about among four
 * hundred lines, and the failures - the only rows anyone opens this for - in the
 * same weight as the two hundred that worked.
 *
 * So it is a console. Fixed-width, densest thing in the product, newest at the
 * bottom, following the run unless you scroll away from it. Every line carries
 * WHEN, WHAT KIND of thing it was, and the message verbatim - the agent's own
 * words, gRPC codes and all, because that string is what somebody pastes into a
 * search when a copy fails.
 *
 * Live by POLLING, not by subscription: this is open for a minute at a time,
 * it wants the whole list rather than a tail, and one query every second and a
 * half for as long as somebody is looking at it is cheaper than a second SSE
 * per tab that has to be reconciled with the first.
 */

const RUN_LOG = /* GraphQL */ `
  query MigrationLog($id: String!) {
    dokployImport(id: $id) {
      id
      status
      error
      created
      skipped
      failed
      manual
      phase
      stepLabel
      items {
        path
        sourceKind
        sourceName
        outcome
        targetKind
        message
        at
      }
    }
  }
`;

const POLL_MS = 1500;

interface RunLog {
  id: string;
  status: string;
  error: string | null;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  phase: string;
  stepLabel: string | null;
  items: ReportItem[];
}

/** The four outcomes, and what each one looks like at a glance. */
const LEVELS = {
  created: {
    label: "Created",
    icon: Check,
    tone: "text-success",
    dot: "bg-success",
  },
  skipped: {
    label: "Skipped",
    icon: SkipForward,
    tone: "text-muted-foreground",
    dot: "bg-muted-foreground",
  },
  manual: {
    label: "Needs you",
    icon: Info,
    tone: "text-warning",
    dot: "bg-warning",
  },
  failed: {
    label: "Failed",
    icon: TriangleAlert,
    tone: "text-destructive",
    dot: "bg-destructive",
  },
} as const;

type Level = keyof typeof LEVELS;

/** Anything the server sends that is not one of the four reads as "needs you". */
function levelOf(outcome: string): Level {
  return outcome in LEVELS ? (outcome as Level) : "manual";
}

/** `2026-08-25T00:14:09.123Z` -> `00:14:09`. Local time, seconds, nothing else. */
function clock(at: string | null | undefined): string {
  if (!at) return "--:--:--";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString(undefined, { hour12: false });
}

export function MigrationConsole({
  runId,
  open,
  onOpenChange,
  live,
}: {
  runId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Keep polling. False once the run is over: the list cannot change again. */
  live: boolean;
}) {
  const [log, setLog] = React.useState<RunLog | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [only, setOnly] = React.useState<Level | null>(null);
  const [follow, setFollow] = React.useState(true);
  const bottom = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open || !runId) return;
    let alive = true;
    const read = async () => {
      try {
        const d = await gql<{ dokployImport: RunLog | null }>(RUN_LOG, {
          id: runId,
        });
        if (!alive) return;
        setError(null);
        setLog(d.dokployImport);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void read();
    if (!live)
      return () => {
        alive = false;
      };
    const t = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, runId, live]);

  // Its own memo: a fresh `[]` on every render would re-run the filter below on
  // every render too, which on a four-hundred-line log while polling is the
  // difference between a console and a stutter.
  const items = React.useMemo(() => log?.items ?? [], [log]);
  const shown = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (only && levelOf(i.outcome) !== only) return false;
      if (!q) return true;
      return (
        i.path.toLowerCase().includes(q) ||
        i.sourceName.toLowerCase().includes(q) ||
        (i.message ?? "").toLowerCase().includes(q) ||
        i.sourceKind.toLowerCase().includes(q)
      );
    });
  }, [items, query, only]);

  // Follow the tail, unless somebody scrolled away from it. Reading line 40 of
  // 300 while the thing yanks itself to the bottom every second is the one way
  // to make a live log worse than a static one.
  React.useEffect(() => {
    if (!follow || !open) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow, open]);

  const counts: Record<Level, number> = {
    created: log?.created ?? 0,
    skipped: log?.skipped ?? 0,
    manual: log?.manual ?? 0,
    failed: log?.failed ?? 0,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col gap-3">
        <DialogHeader>
          <DialogTitle>Migration log</DialogTitle>
          <DialogDescription>
            {log?.status === "running"
              ? `${log.phase === "data" ? "Copying data" : "Importing"}${log.stepLabel ? `: ${log.stepLabel}` : ""}`
              : (log?.error ?? "Every line this migration wrote.")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="pl-8"
            />
          </div>
          {(Object.keys(LEVELS) as Level[]).map((lv) => {
            const on = only === lv;
            return (
              <Button
                key={lv}
                type="button"
                variant={on ? "secondary" : "outline"}
                onClick={() => setOnly(on ? null : lv)}
                className="gap-1.5"
              >
                <span className={cn("size-2 rounded-full", LEVELS[lv].dot)} />
                {LEVELS[lv].label}
                <span className="text-muted-foreground">{counts[lv]}</span>
              </Button>
            );
          })}
          <Button
            type="button"
            variant={follow ? "secondary" : "outline"}
            onClick={() => setFollow((f) => !f)}
            title="Keep the newest line in view"
          >
            <ArrowDownToLine className="size-4" />
            Follow
          </Button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/30 font-mono text-xs"
          onWheel={(e) => {
            // Scrolling UP is the signal, and it is the only one that is never
            // ambiguous: a wheel down at the bottom means nothing.
            if (e.deltaY < 0 && follow) setFollow(false);
          }}
        >
          {error && <p className="p-3 text-destructive">{error}</p>}
          {!error && shown.length === 0 && (
            <p className="p-3 text-muted-foreground">
              {items.length === 0
                ? "Nothing yet."
                : "Nothing matches that filter."}
            </p>
          )}
          <ul className="divide-y divide-border/40">
            {shown.map((i, n) => {
              const lv = LEVELS[levelOf(i.outcome)];
              const Icon = lv.icon;
              return (
                <li
                  key={`${i.path}-${i.sourceName}-${n}`}
                  className="flex gap-2 px-3 py-1.5 hover:bg-background/60"
                >
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {clock(i.at)}
                  </span>
                  <Icon className={cn("mt-0.5 size-3.5 shrink-0", lv.tone)} />
                  <Badge
                    variant="muted"
                    className="h-5 shrink-0 px-1.5 font-mono text-[10px]"
                  >
                    {i.sourceKind}
                  </Badge>
                  <span className="min-w-0 flex-1 break-words">
                    <span className="text-foreground">{i.path}</span>
                    {i.message && (
                      <span className={cn("ml-2", lv.tone)}>{i.message}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          <div ref={bottom} />
        </div>

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {shown.length === items.length
              ? `${items.length} line(s)`
              : `${shown.length} of ${items.length} line(s)`}
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="size-4" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
