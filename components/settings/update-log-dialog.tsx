"use client";

import * as React from "react";
import {
  CheckCircle2,
  Hand,
  History,
  Loader2,
  PauseCircle,
  RotateCcw,
  SkipForward,
  TriangleAlert,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { TextLine } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
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

const pad = (n: number) => String(n).padStart(2, "0");

/** "Today 03:01", "2 Nov 02:01": on the automatic updates' own clock. */
export function logWhen(at: string, tz: string, now = new Date()): string {
  const d = new Date(at);
  const p = zoneParts(d, tz);
  const n = zoneParts(now, tz);
  const ago = Math.round(
    (Date.UTC(n.y, n.m - 1, n.d) - Date.UTC(p.y, p.m - 1, p.d)) / 86_400_000,
  );
  const day =
    ago === 0
      ? "Today"
      : ago === 1
        ? "Yesterday"
        : new Intl.DateTimeFormat("en-GB", {
            timeZone: tz,
            day: "numeric",
            month: "short",
            ...(p.y === n.y ? {} : { year: "numeric" }),
          }).format(d);
  return `${day} ${pad(p.H)}:${pad(p.M)}`;
}

export function UpdateLogDialog({
  open,
  onOpenChange,
  timezone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timezone: string | null;
}) {
  const [entries, setEntries] = React.useState<UpdateLogEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    void gqlAction<{ deploUpdateLog: UpdateLogEntry[] }, UpdateLogEntry[]>(
      QUERY,
      undefined,
      (d) => d.deploUpdateLog,
    ).then((res) => {
      if (!live) return;
      setError(res.ok ? null : res.error);
      if (res.ok) setEntries(res.data ?? []);
    });
    return () => {
      live = false;
    };
  }, [open]);

  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Update log</DialogTitle>
          <DialogDescription>
            Every update of Deplo in the last 90 days, in <strong>{tz}</strong>{" "}
            time. <DocsLink topic="upgrade.log" />
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="flex items-center gap-2 text-sm">
            <TriangleAlert className="size-4 shrink-0 text-warning" />
            {error}
          </p>
        ) : entries === null ? (
          <div role="status" aria-busy aria-label="Loading the update log">
            <TextLine className="w-72" />
            <TextLine className="mt-3 w-56" />
            <TextLine className="mt-3 w-64" />
          </div>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="No updates yet"
            description="Each update of Deplo shows up here, with who started it and how it went."
          />
        ) : (
          <LogEntries entries={entries} tz={tz} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LogEntries({
  entries,
  tz,
}: {
  entries: UpdateLogEntry[];
  tz: string;
}) {
  const now = new Date();
  return (
    <>
      <div className="rounded-xl border border-border max-md:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="align-top whitespace-nowrap text-muted-foreground">
                  {logWhen(e.at, tz, now)}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex gap-2">
                    <span className="mt-0.5 shrink-0">{ICON[e.outcome]}</span>
                    <div className="min-w-0">
                      <p className="font-medium">{entrySentence(e)}</p>
                      {e.reason && (
                        <p className="text-xs text-muted-foreground">
                          {e.reason}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="align-top font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {e.fromVersion} → {e.toVersion}
                </TableCell>
                <TableCell className="align-top whitespace-nowrap text-muted-foreground">
                  {updateLogActor(e)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y divide-border rounded-xl border border-border bg-background md:hidden">
        {entries.map((e) => (
          <li key={e.id} className="flex gap-3 px-4 py-3">
            <span className="mt-0.5 shrink-0">{ICON[e.outcome]}</span>
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline justify-between gap-2 text-sm font-medium">
                {entrySentence(e)}
                <span className="shrink-0 text-xs font-normal text-muted-foreground">
                  {logWhen(e.at, tz, now)}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {updateLogActor(e)} · {e.fromVersion} → {e.toVersion}
              </p>
              {e.reason && (
                <p className="mt-1 text-xs text-muted-foreground">{e.reason}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
