"use client";

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn, formatBytes } from "@/lib/utils";
import type { DestinationCardView } from "@/components/storage/destination-actions";

const FULL_PCT = 80;

interface Shares {
  backups: number;
  other: number;
  usedPct: number;
  used: number;
  backupBytes: number;
  otherBytes: number;
}

export function spaceShares(
  storedBytes: number,
  freeBytes: number,
  totalBytes: number,
): Shares {
  const used = Math.max(0, totalBytes - freeBytes);
  const backupBytes = Math.min(storedBytes, used);
  const otherBytes = Math.max(0, used - backupBytes);
  return {
    backups: (backupBytes / totalBytes) * 100,
    other: (otherBytes / totalBytes) * 100,
    usedPct: (used / totalBytes) * 100,
    used,
    backupBytes,
    otherBytes,
  };
}

export function measured(dest: DestinationCardView): boolean {
  return dest.freeBytes !== null && Boolean(dest.totalBytes);
}

function Bar({ shares, className }: { shares: Shares; className?: string }) {
  const full = shares.usedPct > FULL_PCT;
  return (
    <div
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-secondary",
        className,
      )}
    >
      <div
        className={cn(
          "h-full transition-all",
          full ? "bg-[var(--warning)]" : "bg-primary",
        )}
        style={{ width: `${shares.backups}%` }}
      />
      <div
        className={cn(
          "h-full transition-all",
          full ? "bg-[var(--warning)]/45" : "bg-ring",
        )}
        style={{ width: `${shares.other}%` }}
      />
    </div>
  );
}

export function DestinationBar({ dest }: { dest: DestinationCardView }) {
  if (!measured(dest)) return null;
  const shares = spaceShares(
    dest.storedBytes,
    dest.freeBytes!,
    dest.totalBytes!,
  );
  return (
    <SimpleTooltip
      content={`${formatBytes(shares.backupBytes)} of backups · ${formatBytes(shares.otherBytes)} used by other things · ${formatBytes(dest.freeBytes!)} free`}
    >
      <Bar shares={shares} />
    </SimpleTooltip>
  );
}

export function spaceLabel(dest: DestinationCardView): string {
  if (!measured(dest)) return "Measured when tested";
  const shares = spaceShares(
    dest.storedBytes,
    dest.freeBytes!,
    dest.totalBytes!,
  );
  return `${formatBytes(dest.freeBytes!)} free of ${formatBytes(dest.totalBytes!)} · ${Math.round(shares.usedPct)}% used`;
}

export function storedLabel(dest: DestinationCardView): string {
  if (dest.storedCount === 0) return "None yet";
  return `${formatBytes(dest.storedBytes)} in ${dest.storedCount} ${dest.storedCount === 1 ? "backup" : "backups"}`;
}

export function DestinationSpaceCell({ dest }: { dest: DestinationCardView }) {
  if (dest.kind !== "server")
    return (
      <span className="text-muted-foreground">
        {dest.storedCount === 0 ? "—" : formatBytes(dest.storedBytes)}
      </span>
    );
  if (!measured(dest))
    return <span className="text-muted-foreground">Not measured</span>;
  const shares = spaceShares(
    dest.storedBytes,
    dest.freeBytes!,
    dest.totalBytes!,
  );
  return (
    <SimpleTooltip
      content={`${formatBytes(shares.backupBytes)} of backups · ${formatBytes(dest.freeBytes!)} free of ${formatBytes(dest.totalBytes!)}`}
    >
      <span className="flex items-center gap-2">
        <Bar shares={shares} className="w-24" />
        <span className="tabular-nums">{Math.round(shares.usedPct)}%</span>
      </span>
    </SimpleTooltip>
  );
}
