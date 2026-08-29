"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
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
}: {
  servers: { id: string; name: string; status: ServerStatus; ip: string }[];
  rows: Record<string, FleetRow>;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
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
          <span className="hidden w-16 text-right lg:block">Containers</span>
        </div>
        <ul className="divide-y divide-border">
          {servers.map((s) => {
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
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onSelect(s.id)}
                  aria-pressed={selected}
                  className={cn(
                    "relative flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                    selected ? "bg-accent/40" : "hover:bg-accent/20",
                  )}
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
                    <InfoTip
                      side="top"
                      label="Sampling backend"
                      content="This host samples through docker stats instead of cgroups, which costs the machine noticeably more CPU. Updating the agent usually switches it back."
                    />
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
                      <p className="hidden w-16 text-right text-sm font-medium tabular-nums lg:block">
                        {row.containers}
                      </p>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No data
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
