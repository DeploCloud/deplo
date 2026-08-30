"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn, formatBytes } from "@/lib/utils";
import type { DestinationCardView } from "@/components/storage/destination-actions";

/** Past this share of the disk the bar goes amber, like the metrics tiles. */
const FULL_PCT = 80;

interface Shares {
  /** What this destination's own artifacts take, as a % of the disk. */
  backups: number;
  /** What everything else on that filesystem takes, as a %. */
  other: number;
  usedPct: number;
  used: number;
  backupBytes: number;
  otherBytes: number;
}

/**
 * Split a measured filesystem into "our backups" / "everything else" / free. The
 * stored figure is the control plane's accounting and the free figure is the
 * host's, so clamp rather than trust the subtraction.
 */
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

/** True when this destination has been measured at least once. */
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

/**
 * The disk a server destination sits on, as one bar. The figures behind it are
 * `dl` rows on the card, so the bar itself only has to show the proportion.
 */
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

/** "331 GB free of 431 GB · 23% used", or why there is no figure yet. */
export function spaceLabel(dest: DestinationCardView): string {
  if (!measured(dest)) return "Measured when tested";
  const shares = spaceShares(
    dest.storedBytes,
    dest.freeBytes!,
    dest.totalBytes!,
  );
  return `${formatBytes(dest.freeBytes!)} free of ${formatBytes(dest.totalBytes!)} · ${Math.round(shares.usedPct)}% used`;
}

/** "412 MB in 1 backup" - what this destination is actually holding. */
export function storedLabel(dest: DestinationCardView): string {
  if (dest.storedCount === 0) return "None yet";
  return `${formatBytes(dest.storedBytes)} in ${dest.storedCount} ${dest.storedCount === 1 ? "backup" : "backups"}`;
}

/** The same figure squeezed into a table cell: a short bar, or the stored size. */
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
