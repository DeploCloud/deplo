"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { AlertTriangle, Cloud, Loader2, Server } from "lucide-react";

import { Combobox } from "@/components/shared/combobox";
import { StatusBadge } from "@/components/shared/status-badge";
import { probeDestinations } from "@/lib/destination-probe";
import type { DestinationStatus } from "@/lib/types";
import type { DestinationOption } from "@/lib/data/destinations";

/** The stored badge is only a starting point; this is what the live probe returns. */
interface LiveStatus {
  status: DestinationStatus;
  error: string | null;
}

/**
 * Pick a backup destination by typing, with the list proving itself as it opens.
 * Until it lands, each row shows the stored verdict, so the list is never empty or
 * frozen while the network works.
 */
export function DestinationCombobox({
  destinations,
  value,
  onChange,
  id,
  disabled,
  sameDiskServerId,
  sameDiskNoun = "app",
  canProbe = false,
}: {
  destinations: DestinationOption[];
  /** The selected destination id, or "" for none. */
  value: string;
  onChange: (id: string) => void;
  id?: string;
  disabled?: boolean;
  /**
   * The server the thing being backed up runs on.
   */
  sameDiskServerId?: string | null;
  /** What that warning calls the thing being backed up. */
  sameDiskNoun?: "app" | "database";
  /**
   * Whether this user holds `manage_backup_destinations`, the capability the live
   * probe needs.
   */
  canProbe?: boolean;
}) {
  const [live, setLive] = React.useState<Record<string, LiveStatus>>({});
  const [probing, setProbing] = React.useState(false);

  const selected = destinations.find((d) => d.id === value) ?? null;
  const sameDisk =
    !!sameDiskServerId &&
    selected?.kind === "server" &&
    selected.serverId === sameDiskServerId;

  /** Re-probe every destination and repaint the badges from the verdicts. */
  const probe = React.useCallback(() => {
    if (!canProbe) return;
    setProbing(true);
    void probeDestinations()
      .then((rows) => {
        // A skipped or failed round leaves the stored badges in place - opening a
        // dropdown is not the place to raise an error the user did not ask for.
        if (!rows) return;
        setLive(
          Object.fromEntries(
            rows.map((d) => [
              d.id,
              { status: d.status, error: d.lastTestError },
            ]),
          ),
        );
      })
      .finally(() => setProbing(false));
  }, [canProbe]);

  return (
    <Combobox<DestinationOption>
      id={id}
      items={destinations}
      value={value}
      onChange={onChange}
      getKey={(d) => d.id}
      // Typing filters over BOTH the name and the location: searching "r2", an
      // account id or a server name finds the destination when nobody remembers
      // what it was called.
      matches={(d, q) =>
        d.name.toLowerCase().includes(q) || d.where.toLowerCase().includes(q)
      }
      displayValue={(d) => d.name}
      placeholder="Select a destination"
      searchPlaceholder="Search destinations"
      emptyLabel={(hasItems) =>
        hasItems ? "No destination matches that" : "No backup destinations yet"
      }
      disabled={disabled}
      busy={probing}
      onOpen={probe}
      renderOption={(d) => {
        const status = live[d.id]?.status ?? d.status;
        const error = live[d.id]?.error ?? null;
        return (
          <>
            <span className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                {d.kind === "server" ? (
                  <Server className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate text-sm">{d.name}</span>
              </span>
              {probing ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                <StatusBadge
                  status={status}
                  tinted
                  labels={{ unverified: "Not tested" }}
                />
              )}
            </span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {d.where}
            </span>
            {/* Why it is red, without making anyone open Storage. */}
            {status === "error" && error && !probing && (
              <span className="block truncate text-xs text-destructive">
                {error}
              </span>
            )}
          </>
        );
      }}
      footer={
        // Same-disk honesty, only once it is actually the choice.
        sameDisk && selected ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs font-medium">
                Same disk as this {sameDiskNoun}
              </p>
              <p className="text-xs text-muted-foreground">
                {selected.name} is on the server this {sameDiskNoun} runs on. It
                protects against a mistake, not against a disk failure.
              </p>
            </div>
          </div>
        ) : null
      }
    />
  );
}
