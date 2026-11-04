"use client";

import * as React from "react";
import {
  CheckCircle2,
  ChevronRight,
  Hand,
  History,
  Loader2,
  PauseCircle,
  RotateCcw,
  SkipForward,
  TriangleAlert,
} from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { TextLine } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { titleClass } from "@/components/shared/page-header";
import { gqlAction } from "@/lib/graphql-client";
import { zoneParts } from "@/lib/crons/cron-tz";
import type { UpdateLogEntry } from "@/lib/data/update-log";

const QUERY = /* GraphQL */ `
  query DeploUpdateLog {
    deploUpdateLog {
      id
      trigger
      outcome
      fromVersion
      toVersion
      actor
      reason
      at
      finishedAt
    }
  }
`;

export function updateLogActor(e: UpdateLogEntry): string {
  if (e.actor) return e.actor;
  if (e.trigger === "automatic") return "Automatic";
  if (e.trigger === "host") return "Installer";
  return "Update button";
}

const ICON: Record<UpdateLogEntry["outcome"], React.ReactNode> = {
  running: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
  updated: <CheckCircle2 className="size-4 text-success" />,
  rolled_back: <RotateCcw className="size-4 text-warning" />,
  failed: <TriangleAlert className="size-4 text-destructive" />,
  skipped: <SkipForward className="size-4 text-muted-foreground" />,
  postponed: <PauseCircle className="size-4 text-muted-foreground" />,
  held: <Hand className="size-4 text-warning" />,
};

export function entrySentence(e: UpdateLogEntry): string {
  const v = e.toVersion;
  switch (e.outcome) {
    case "running":
      return `Updating to ${v}`;
    case "updated":
      return `Updated to ${v}`;
    case "rolled_back":
      return `${v} rolled back`;
    case "failed":
      return `${v} did not install`;
    case "skipped":
      return `Waited on ${v}`;
    case "postponed":
      return `${v} postponed`;
    case "held":
      return `${v} needs you`;
  }
}

export interface LogDay {
  label: string;
  items: { entry: UpdateLogEntry; time: string }[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Newest first, one group per day on the automatic updates' own clock. */
export function groupByDay(
  entries: UpdateLogEntry[],
  tz: string,
  now = new Date(),
): LogDay[] {
  const day = (d: Date) => {
    const p = zoneParts(d, tz);
    return Date.UTC(p.y, p.m - 1, p.d);
  };
  const today = day(now);
  const days: LogDay[] = [];
  let current: number | null = null;
  for (const entry of entries) {
    const at = new Date(entry.at);
    const key = day(at);
    if (key !== current) {
      current = key;
      const ago = Math.round((today - key) / 86_400_000);
      const label =
        ago === 0
          ? "Today"
          : ago === 1
            ? "Yesterday"
            : new Intl.DateTimeFormat("en-GB", {
                timeZone: tz,
                day: "numeric",
                month: "short",
                ...(zoneParts(at, tz).y === zoneParts(now, tz).y
                  ? {}
                  : { year: "numeric" }),
              }).format(at);
      days.push({ label, items: [] });
    }
    const p = zoneParts(at, tz);
    days[days.length - 1].items.push({
      entry,
      time: `${pad(p.H)}:${pad(p.M)}`,
    });
  }
  return days;
}

export function UpdateLogView({
  timezone,
  onBack,
}: {
  timezone: string | null;
  onBack: () => void;
}) {
  const [entries, setEntries] = React.useState<UpdateLogEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let live = true;
    void gqlAction<{ deploUpdateLog: UpdateLogEntry[] }, UpdateLogEntry[]>(
      QUERY,
      undefined,
      (d) => d.deploUpdateLog,
    ).then((res) => {
      if (!live) return;
      if (res.ok) setEntries(res.data ?? []);
      else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, []);

  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <nav
          aria-label="Breadcrumb"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <button
            type="button"
            onClick={onBack}
            className="cursor-pointer font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            Updates
          </button>
          <ChevronRight className="size-3.5" />
          <span>Update log</span>
        </nav>
        <h2 className={`${titleClass.section} flex items-center gap-1.5`}>
          Update log
          <InfoTip
            content="Every update of Deplo in the last 90 days, from the Update button, the automatic updates or the installer."
            docs="upgrade.log"
          />
        </h2>
        <p className="text-sm text-muted-foreground">
          Newest first, in {tz} time.
        </p>
      </div>
      <Card>
        <CardContent className="p-5">
          {error ? (
            <p className="flex items-center gap-2 text-sm">
              <TriangleAlert className="size-4 shrink-0 text-warning" />
              {error}
            </p>
          ) : entries === null ? (
            <div role="status" aria-busy aria-label="Loading the update log">
              <TextLine className="w-24" />
              <TextLine className="mt-4 w-72" />
              <TextLine className="mt-2 w-48" />
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={History}
              title="No updates yet"
              docs="upgrade.log"
              description="Each update of Deplo shows up here, with who started it and how it went."
            />
          ) : (
            <Timeline days={groupByDay(entries, tz)} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Timeline({ days }: { days: LogDay[] }) {
  return (
    <div className="space-y-6">
      {days.map((d) => (
        <section key={d.label} className="space-y-3">
          <h3 className="text-xs font-medium text-muted-foreground uppercase">
            {d.label}
          </h3>
          <ol>
            {d.items.map(({ entry: e, time }, i) => (
              <li key={e.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface">
                    {ICON[e.outcome]}
                  </span>
                  {i < d.items.length - 1 && (
                    <span className="w-px flex-1 bg-border" />
                  )}
                </div>
                <div className="min-w-0 flex-1 pb-4">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                    {entrySentence(e)}
                    <span className="text-xs text-muted-foreground">
                      {time} · {updateLogActor(e)}
                    </span>
                  </p>
                  {e.reason ? (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {e.reason}
                    </p>
                  ) : (
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {e.fromVersion} → {e.toVersion}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
