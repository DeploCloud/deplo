"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bone } from "@/components/ui/skeleton";
import {
  StatusMark,
  type StatusTone,
} from "@/components/monitoring/status-mark";
import type { FleetRow } from "@/components/monitoring/fleet-list";
import type { ServerStatus } from "@/lib/types/server";
import { serverLabel } from "@/lib/utils";

// A moment at 85% is normal work; at 90% it is about to hurt.
const ATTENTION_PCT = 90;
const SHOWN = 3;

export interface FleetProblem {
  id: string;
  text: string;
}

type StatusServer = { id: string; name: string; status: ServerStatus };

// Offline first, then whatever is closest to full.
export function fleetProblems(
  servers: StatusServer[],
  rows: Record<string, FleetRow>,
): FleetProblem[] {
  const found: (FleetProblem & { rank: number })[] = [];
  for (const s of servers) {
    const name = serverLabel(s);
    if (s.status === "offline" || s.status === "error") {
      found.push({ id: s.id, text: `${name} is offline`, rank: Infinity });
      continue;
    }
    const row = rows[s.id];
    if (!row || row.ts <= 0) continue;
    const worst = [
      { v: row.diskPct, text: "is almost out of disk" },
      { v: row.memPct, text: "is low on memory" },
      { v: row.cpu, text: "is very busy" },
    ]
      .filter((x) => x.v >= ATTENTION_PCT)
      .sort((a, b) => b.v - a.v)[0];
    if (worst)
      found.push({ id: s.id, text: `${name} ${worst.text}`, rank: worst.v });
  }
  return found
    .sort((a, b) => b.rank - a.rank)
    .map(({ id, text }) => ({ id, text }));
}

const isOffline = (s: StatusServer) =>
  s.status === "offline" || s.status === "error";

export function FleetStatus({
  servers,
  rows,
  onOpen,
  onSeeAll,
}: {
  servers: StatusServer[];
  rows: Record<string, FleetRow>;
  onOpen: (id: string) => void;
  onSeeAll?: () => void;
}) {
  const problems = fleetProblems(servers, rows);
  const many = servers.length > 1;
  const more = problems.length - SHOWN;
  return (
    <FleetStatusFrame
      tone={
        problems.length === 0 ? "ok" : servers.some(isOffline) ? "bad" : "warn"
      }
      title={
        problems.length === 0
          ? many
            ? "All servers are fine"
            : "Your server is fine"
          : problems.length === 1
            ? "1 server needs attention"
            : `${problems.length} servers need attention`
      }
      action={
        many &&
        onSeeAll && (
          <Button variant="outline" size="sm" onClick={onSeeAll}>
            See all servers
            <ChevronRight className="size-4" />
          </Button>
        )
      }
    >
      {problems.length === 0
        ? many
          ? `${servers.length} servers, nothing needs you right now.`
          : "Nothing needs you right now."
        : problems.slice(0, SHOWN).map((p, i) => (
            <React.Fragment key={p.id}>
              {i > 0 && <span className="mx-2">·</span>}
              <ProblemLink onClick={() => onOpen(p.id)}>{p.text}</ProblemLink>
            </React.Fragment>
          ))}
      {more > 0 && onSeeAll && (
        <>
          <span className="mx-2">·</span>
          <ProblemLink onClick={onSeeAll}>{more} more</ProblemLink>
        </>
      )}
    </FleetStatusFrame>
  );
}

function ProblemLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
    >
      {children}
    </button>
  );
}

const TINT: Record<StatusTone, string> = {
  ok: "var(--green)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
};

function FleetStatusFrame({
  tone,
  title,
  action,
  loading = false,
  children,
}: {
  tone: StatusTone;
  title: string;
  action?: React.ReactNode;
  loading?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border border-border px-6 py-5"
      style={{
        background: `linear-gradient(100deg, color-mix(in srgb, ${TINT[tone]} 9%, var(--card)), var(--card) 55%)`,
      }}
    >
      {loading ? (
        <Bone box className="size-20 rounded-full">
          <span className="size-20" />
        </Bone>
      ) : (
        <StatusMark key={tone} tone={tone} />
      )}
      <div className="min-w-0 flex-1">
        <h2 className="text-2xl font-semibold tracking-tight">
          <Bone loading={loading}>{title}</Bone>
        </h2>
        <div className="mt-1.5 text-sm text-muted-foreground">
          <Bone loading={loading}>{children}</Bone>
        </div>
      </div>
      {action}
    </section>
  );
}

export function FleetStatusSkeleton() {
  return (
    <FleetStatusFrame loading tone="ok" title="All servers are fine">
      4 servers, nothing needs you right now.
    </FleetStatusFrame>
  );
}
