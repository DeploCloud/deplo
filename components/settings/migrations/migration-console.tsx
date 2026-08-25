"use client";

import * as React from "react";
import {
  ArrowDownToLine,
  Check,
  CircleSlash,
  Copy,
  Search,
  SkipForward,
  SlidersHorizontal,
  TriangleAlert,
  Info,
  X,
} from "lucide-react";
import { toast } from "sonner";

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
import { FacetMenu, type EnvFacet } from "@/components/env/env-filters";
import type { ReportItem } from "./types";

/**
 * What a migration did, line by line - while it runs, and ever after.
 *
 * The ONE viewer for a run's log. There used to be two: this console for
 * whoever started the run, and a "Report" dialog - same rows, grouped by
 * outcome, no timestamps, no search - for everybody else, for the end of the
 * wizard and for History. One table read two ways is two answers to the same
 * question, and the one people were handed depended on which door they came
 * through. This is the surviving one, because chronology is what a log is.
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

/**
 * One document for the whole feature. `settleFinished` in the wizard reads the
 * run through it too - it wants `status` and `error`, which are on it already -
 * so a field renamed in the schema breaks one query rather than two.
 */
export const RUN_LOG = /* GraphQL */ `
  query MigrationLog($id: String!) {
    dokployImport(id: $id) {
      id
      status
      error
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
  phase: string;
  stepLabel: string | null;
  items: ReportItem[];
}

/** The five outcomes, and what each one looks like at a glance. */
const LEVELS = {
  created: {
    label: "Created",
    icon: Check,
    tone: "text-success",
  },
  skipped: {
    label: "Skipped",
    icon: SkipForward,
    tone: "text-muted-foreground",
  },
  // Its own row, not folded into "Needs you": "Deplo has no equivalent for this"
  // is a different sentence from "this came over, go and look at it", and the
  // grouped report the console replaced said them apart.
  unsupported: {
    label: "No equivalent",
    icon: CircleSlash,
    tone: "text-muted-foreground",
  },
  manual: {
    label: "Needs you",
    icon: Info,
    tone: "text-warning",
  },
  failed: {
    label: "Failed",
    icon: TriangleAlert,
    tone: "text-destructive",
  },
} as const;

type Level = keyof typeof LEVELS;

/** Anything the server sends that is not one of the five reads as "needs you". */
function levelOf(outcome: string): Level {
  return outcome in LEVELS ? (outcome as Level) : "manual";
}

/**
 * The five outcomes as ONE multi-select menu, not five toggle pills.
 *
 * The pills were five buttons wide - half the toolbar - and they were
 * single-pick: "failed" hid the "needs you" rows you were reading them next to.
 * `FacetMenu` is the control every other log console in the app already wears
 * (`components/logs/log-filters.tsx` uses it for levels), checkboxes, per-option
 * counts and all.
 */
const LEVEL_FACET: EnvFacet<ReportItem> = {
  id: "outcome",
  label: "Outcome",
  allLabel: "All outcomes",
  icon: SlidersHorizontal,
  options: (Object.keys(LEVELS) as Level[]).map((value) => ({
    value,
    label: LEVELS[value].label,
    // The row reads in its own severity colour, the way the lines below do.
    labelClassName: LEVELS[value].tone,
  })),
  match: (row, value) => levelOf(row.outcome) === value,
};

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
  // Stamped with the run it came from, so re-opening the dialog on a DIFFERENT
  // run never paints the previous one's lines while this one's are on the way -
  // and `undefined` (nothing read yet) stays distinct from `null` (the server
  // says there is no such run), which the empty state below tells apart.
  const [fetched, setFetched] = React.useState<{
    runId: string;
    log: RunLog | null;
  } | null>(null);
  const log = fetched?.runId === runId ? fetched.log : undefined;
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [levels, setLevels] = React.useState<string[]>([]);
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
        setFetched({ runId, log: d.dokployImport });
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
  // The SEARCH pass on its own: the menu's counts have to say how many rows
  // picking an outcome would leave, which means every other filter applied and
  // that one not.
  const searched = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (i) =>
        i.path.toLowerCase().includes(q) ||
        i.sourceName.toLowerCase().includes(q) ||
        (i.message ?? "").toLowerCase().includes(q) ||
        i.sourceKind.toLowerCase().includes(q),
    );
  }, [items, query]);
  const shown = React.useMemo(
    () =>
      levels.length === 0
        ? searched
        : searched.filter((i) => levels.includes(levelOf(i.outcome))),
    [searched, levels],
  );

  // Follow the tail, unless somebody scrolled away from it. Reading line 40 of
  // 300 while the thing yanks itself to the bottom every second is the one way
  // to make a live log worse than a static one.
  React.useEffect(() => {
    if (!follow || !open) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow, open]);

  // Counted here rather than read off the run: the stored counters fold
  // `unsupported` into `manual` (see `refreshCounts`), so a chip reading them
  // would disagree with the rows its own filter shows.
  const counts = searched.reduce(
    (acc, i) => {
      acc[levelOf(i.outcome)] += 1;
      return acc;
    },
    { created: 0, skipped: 0, unsupported: 0, manual: 0, failed: 0 } as Record<
      Level,
      number
    >,
  );

  function copyLog() {
    // What is on screen, not the whole run: somebody who filtered to the four
    // failures is copying four failures.
    navigator.clipboard.writeText(
      shown
        .map(
          (i) =>
            `${clock(i.at)}  ${i.outcome.padEnd(11)} ${i.sourceKind.padEnd(9)} ${i.path}` +
            (i.message ? `  ${i.message}` : ""),
        )
        .join("\n"),
    );
    toast.success("Log copied");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `selfManaged`: the shell wraps its children in a scrolling GRID, where
          the log pane's `flex-1` means nothing - so the pane grew with the log
          and pushed the line count and the buttons down out of reach. This
          dialog is a flex column that owns its own height: header and toolbar at
          the top, the pane taking what is left and scrolling inside itself, the
          footer against the bottom edge and staying there. */}
      <DialogContent
        selfManaged
        className="flex h-[85dvh] max-w-4xl flex-col gap-3"
      >
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
          {/* Its own width rather than `FacetMenu`'s `flex-1`, which would eat
              the row it shares with the search box. */}
          <div className="flex w-44 shrink-0 items-center">
            <FacetMenu
              facet={LEVEL_FACET}
              values={levels}
              counts={counts}
              onChange={setLevels}
            />
          </div>
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
              {/* A run that is gone is a row somebody deleted out from under
                  this list; saying so beats an empty console. */}
              {log === null
                ? "That migration is no longer here."
                : items.length === 0
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
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              onClick={copyLog}
              disabled={shown.length === 0}
            >
              <Copy className="size-4" />
              Copy
            </Button>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              <X className="size-4" />
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
