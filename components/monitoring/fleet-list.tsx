"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ManageServerButton } from "@/components/monitoring/host-chip";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { Sparkline } from "@/components/monitoring/sparkline";
import type { ServerStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface FleetRow {
  serverId: string;
  online: boolean;
  ts: number;
  cpu: number;
  memPct: number;
  diskPct: number;
  containers: number;
  agentVersion: string | null;
  expectedAgentVersion: string;
  source: string;
  spark: { ts: number; cpu: number; mem: number }[];
}

/** Amber past this, matching the gauges and the old saturation bar. */
const WARN_PCT = 80;

/** Rows past this and the list scrolls instead of pushing the panels off screen. */
const MAX_ROWS = 6;

/**
 * How hard a host is working: its fullest of the three. Unmeasured sorts last -
 * it is not "idle", it is unknown, and it does not belong above a busy machine.
 */
function severity(row: FleetRow | undefined): number {
  if (!row || row.ts <= 0) return -1;
  return Math.max(row.cpu, row.memPct, row.diskPct);
}

/**
 * Worst first, in 10-point buckets. The bucket is the whole point: sorting on the
 * raw percentage would reshuffle the list every second on CPU jitter, and a row
 * that moves under the pointer is worse than a row in the wrong place.
 */
function worstFirst(rows: Record<string, FleetRow>) {
  return (a: { id: string; name: string }, b: { id: string; name: string }) => {
    const bucket = (v: number) => (v < 0 ? -1 : Math.floor(v / 10));
    return (
      bucket(severity(rows[b.id])) - bucket(severity(rows[a.id])) ||
      a.name.localeCompare(b.name)
    );
  };
}

/** One reading. The column header names it, so the cell is just the number. */
function Pct({ value, className }: { value: number; className?: string }) {
  return (
    <p
      className={cn(
        "w-14 text-right text-sm font-medium tabular-nums",
        value > WARN_PCT && "text-[var(--warning)]",
        className,
      )}
    >
      {value.toFixed(0)}%
    </p>
  );
}

/**
 * The fleet, one row per server, and the server SELECTOR: clicking a row drives
 * the panels below it. Only mounted with two or more servers - with one host
 * there is nothing to pick and the list would be pure first-run surface.
 */
export function FleetList({
  servers,
  rows,
  selectedId,
  onSelect,
  canManageServers,
}: {
  servers: { id: string; name: string; status: ServerStatus; ip: string }[];
  rows: Record<string, FleetRow>;
  selectedId: string;
  onSelect: (id: string) => void;
  /** The server pages are instance-admin only, so the link is hidden without it
   *  rather than offered and answered with a 404. */
  canManageServers: boolean;
}) {
  // Sorted here, not by the caller: the order IS this list's reading of the fleet.
  const ordered = React.useMemo(
    () => [...servers].sort(worstFirst(rows)),
    [servers, rows],
  );

  // A pick from the search box can land on a row that is scrolled out of sight,
  // and a list showing someone else than the panels do is just wrong.
  const selectedRef = React.useRef<HTMLLIElement>(null);
  React.useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <Card>
      <CardContent className="p-0">
        {/* Named once, in a header, rather than under every number on every row. */}
        <div className="flex items-center gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <span className="size-2.5 shrink-0" aria-hidden />
          <span className="flex-1">Server</span>
          <span className="hidden w-[72px] sm:block" aria-hidden />
          <span className="w-14 text-right">CPU</span>
          <span className="w-14 text-right">RAM</span>
          <span className="hidden w-14 text-right sm:block">Disk</span>
          <span className="hidden w-20 text-right lg:block">Containers</span>
          {canManageServers && <span className="w-[5.25rem]" aria-hidden />}
        </div>
        <ul
          className={cn(
            "divide-y divide-border",
            servers.length > MAX_ROWS && "max-h-[21.5rem] overflow-y-auto",
          )}
        >
          {ordered.map((s) => {
            const row = rows[s.id];
            const measured = Boolean(row && row.ts > 0);
            const selected = s.id === selectedId;
            // Both halves must be known: the expected version comes from an
            // unauthenticated GitHub call that answers empty once its hourly
            // quota is gone, and an empty answer must never read as a verdict.
            const outdated = Boolean(
              row?.expectedAgentVersion &&
              row.agentVersion &&
              row.agentVersion !== row.expectedAgentVersion,
            );
            return (
              <li
                key={s.id}
                ref={selected ? selectedRef : undefined}
                className={cn(
                  "relative flex items-center transition-colors",
                  selected ? "bg-accent/40" : "hover:bg-accent/20",
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-pressed={selected}
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                >
                  {/* The accent bar is what says "these panels are this host's". */}
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inset-y-0 left-0 w-0.5",
                      selected && "bg-primary",
                    )}
                  />
                  <StatusDot status={s.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {s.ip}
                    </p>
                  </div>

                  {outdated && (
                    <Badge variant="outline" className="hidden sm:inline-flex">
                      Agent outdated
                    </Badge>
                  )}
                  {row?.source === "docker-stats" && (
                    // A SPAN, not InfoTip: that one is a <button>, and a button
                    // inside the row's own button is invalid HTML that React
                    // answers by regenerating the whole tree on hydration.
                    <SimpleTooltip content="This host samples through docker stats instead of cgroups, which costs the machine noticeably more CPU. Updating the agent usually switches it back.">
                      <span
                        role="img"
                        aria-label="Sampling through docker stats, the slower path"
                      >
                        <Info className="size-3.5 text-muted-foreground" />
                      </span>
                    </SimpleTooltip>
                  )}

                  {measured ? (
                    <>
                      <Sparkline
                        values={row.spark.map((p) => p.cpu)}
                        ariaLabel={`${s.name} CPU trend`}
                        className="hidden sm:block"
                      />
                      <Pct value={row.cpu} />
                      <Pct value={row.memPct} />
                      <Pct value={row.diskPct} className="hidden sm:block" />
                      <p className="hidden w-20 text-right text-sm font-medium tabular-nums lg:block">
                        {row.containers}
                      </p>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No data
                    </span>
                  )}
                </button>
                {canManageServers && <ManageServerButton id={s.id} />}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
