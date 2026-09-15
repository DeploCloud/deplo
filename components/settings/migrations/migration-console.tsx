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
import { copyText } from "@/lib/clipboard";
import { gql } from "@/lib/graphql-client";
import { FacetMenu } from "@/components/env/env-filters/facet-menu";
import type { EnvFacet } from "@/components/env/env-filters/types";
import type { ReportItem } from "./types";

const RUN_LOG = /* GraphQL */ `
  query MigrationLog($id: String!) {
    migrationRun(id: $id) {
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

function levelOf(outcome: string): Level {
  return outcome in LEVELS ? (outcome as Level) : "manual";
}

const LEVEL_FACET: EnvFacet<ReportItem> = {
  id: "outcome",
  label: "Outcome",
  allLabel: "All outcomes",
  icon: SlidersHorizontal,
  options: (Object.keys(LEVELS) as Level[]).map((value) => ({
    value,
    label: LEVELS[value].label,
    labelClassName: LEVELS[value].tone,
  })),
  match: (row, value) => levelOf(row.outcome) === value,
};

function clock(at: string | null | undefined): string {
  if (!at) return "--:--:--";
  const d = new Date(at);
  return Number.isNaN(d.getTime())
    ? "--:--:--"
    : d.toLocaleTimeString(undefined, { hour12: false });
}

export interface ConsoleRun {
  id: string;
  teamId?: string;
}

export function MigrationConsole({
  runs,
  open,
  onOpenChange,
  live,
}: {
  runs: ConsoleRun[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  live: boolean;
}) {
  const key = runs.map((r) => `${r.id}@${r.teamId ?? ""}`).join(",");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = React.useMemo(() => runs, [key]);
  const [fetched, setFetched] = React.useState<{
    key: string;
    logs: (RunLog | null)[];
  } | null>(null);
  const logs = fetched?.key === key ? fetched.logs : undefined;
  const [error, setError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [levels, setLevels] = React.useState<string[]>([]);
  const [follow, setFollow] = React.useState(true);
  const running = logs?.find((l) => l?.status === "running") ?? null;
  const streaming = logs ? running != null : live;
  const bottom = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open || key === "") return;
    let alive = true;
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = async () => {
      try {
        const got = await Promise.all(
          list.map((r) =>
            gql<{ migrationRun: RunLog | null }>(
              RUN_LOG,
              { id: r.id },
              undefined,
              r.teamId ? { teamId: r.teamId } : undefined,
            ).then((d) => d.migrationRun),
          ),
        );
        if (!alive) return;
        setError(null);
        setFetched({ key, logs: got });
        if (timer && !got.some((l) => l?.status === "running")) {
          clearInterval(timer);
          timer = null;
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void read();
    if (live) timer = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [open, key, list, live]);

  const items = React.useMemo(
    () => (logs ?? []).flatMap((l) => l?.items ?? []),
    [logs],
  );
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

  React.useEffect(() => {
    if (!follow || !open) return;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [shown.length, follow, open]);

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

  async function copyLog() {
    const ok = await copyText(
      shown
        .map(
          (i) =>
            `${clock(i.at)}  ${i.outcome.padEnd(11)} ${i.sourceKind.padEnd(9)} ${i.path}` +
            (i.message ? `  ${i.message}` : ""),
        )
        .join("\n"),
    );
    if (ok) toast.success("Log copied");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        selfManaged
        className="flex h-[85dvh] max-w-4xl flex-col gap-3"
      >
        <DialogHeader>
          <DialogTitle>Migration log</DialogTitle>
          <DialogDescription>
            {running
              ? `${running.phase === "data" ? "Copying data" : "Importing"}${running.stepLabel ? `: ${running.stepLabel}` : ""}`
              : (logs?.find((l) => l?.error)?.error ??
                "Every line this migration wrote.")}
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
          <div className="flex w-44 shrink-0 items-center">
            <FacetMenu
              facet={LEVEL_FACET}
              values={levels}
              counts={counts}
              onChange={setLevels}
            />
          </div>
          {streaming && (
            <Button
              type="button"
              variant={follow ? "secondary" : "outline"}
              onClick={() => setFollow((f) => !f)}
              title="Keep the newest line in view"
            >
              <ArrowDownToLine className="size-4" />
              Follow
            </Button>
          )}
        </div>

        <div
          className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-surface font-mono text-xs"
          onWheel={(e) => {
            if (e.deltaY < 0 && follow) setFollow(false);
          }}
        >
          {error && <p className="p-3 text-destructive">{error}</p>}
          {!error && shown.length === 0 && (
            <p className="p-3 text-muted-foreground">
              {logs?.every((l) => l === null)
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
