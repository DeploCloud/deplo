"use client";

import * as React from "react";
import { AlertTriangle, Cloud, Loader2, Server } from "lucide-react";

import { Combobox } from "@/components/shared/combobox";
import { StatusBadge } from "@/components/shared/status-badge";
import { gqlAction } from "@/lib/graphql-client";
import type { DestinationStatus } from "@/lib/types";
import type { DestinationOption } from "@/lib/data/destinations";

/** The stored badge is only a starting point; this is what the live probe returns. */
interface LiveStatus {
  status: DestinationStatus;
  error: string | null;
}

/**
 * Don't re-probe if one finished this recently.
 *
 * MODULE-LEVEL, not per component, and that is the fix rather than the detail: a
 * probe is a real WRITE against every destination the team has - a PutObject and
 * a DeleteObject on each bucket, a file round-trip on each server - plus a status
 * UPDATE on every row. A per-instance guard meant every picker on the page, and
 * every reopened dialog, started its own round. Thirty seconds is still "live"
 * to a human opening a menu, and it stops a screenful of pickers from becoming a
 * screenful of bucket traffic.
 */
const PROBE_MIN_INTERVAL_MS = 30_000;

/** Shared across every picker on the page — see above. */
let lastProbeAt = 0;
let probeInFlight = false;

/**
 * Pick a backup destination by typing, with the list proving itself as it opens.
 *
 * Choosing where a backup goes is exactly the moment "is this actually
 * reachable?" has to be TRUE rather than remembered, so opening the menu fires a
 * live probe of every destination (`testDestinations` — a bucket HEAD+write, or
 * a folder resolve+write, through the right agent) and repaints each badge from
 * the answer. Until it lands, each row shows the stored verdict, so the list is
 * never empty or frozen while the network works.
 *
 * Each row carries the three things that tell one destination from another: the
 * name, the live connection status, and WHERE it writes — the bucket endpoint,
 * or the server and folder. That is the description precisely because names
 * drift ("backups", "backups-2") while the place never lies about where the data
 * lands.
 *
 * The typing, keyboard and menu behaviour is {@link Combobox}'s; what lives here
 * is the probe, the rows, and the same-disk warning.
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
  /** The server the thing being backed up runs on. Picking a destination that
   *  lives on THAT server is a copy on the same disk — worth having, it survives
   *  a bad migration or a dropped table, but it is not a second place. Said
   *  once, here, at the moment the choice is made. */
  sameDiskServerId?: string | null;
  /** What that warning calls the thing being backed up. */
  sameDiskNoun?: "app" | "database";
  /**
   * Whether this user holds `manage_backup_destinations`, the capability the
   * live probe needs. False means the stored badges are shown as they stand -
   * which is the honest answer, and better than firing a mutation the server
   * refuses and spinning a loader over the refusal.
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
    if (probeInFlight) return;
    if (Date.now() - lastProbeAt < PROBE_MIN_INTERVAL_MS) return;
    probeInFlight = true;
    setProbing(true);
    void gqlAction<
      { testDestinations: { id: string; status: DestinationStatus; lastTestError: string | null }[] },
      { id: string; status: DestinationStatus; lastTestError: string | null }[]
    >(
      `mutation { testDestinations { id status lastTestError } }`,
      {},
      (d) => d.testDestinations,
    )
      .then((res) => {
        // A failed call leaves the stored badges in place — opening a dropdown
        // is not the place to raise an error the user did not ask for.
        if (!res.ok || !res.data) return;
        setLive(
          Object.fromEntries(
            res.data.map((d) => [d.id, { status: d.status, error: d.lastTestError }]),
          ),
        );
      })
      .finally(() => {
        probeInFlight = false;
        lastProbeAt = Date.now();
        setProbing(false);
      });
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
        // Same-disk honesty, only once it is actually the choice. A CARD, not a
        // line of amber text hanging off the field: three lines of wrapped copy
        // under an input read as part of the control and, when this sat inside
        // the field's own box, dragged the chevron down with them.
        sameDisk && selected ? (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-xs font-medium">
                Same disk as this {sameDiskNoun}
              </p>
              <p className="text-xs text-muted-foreground">
                {selected.name} is on the server this {sameDiskNoun} runs on.
                It protects against a mistake, not against a disk failure.
              </p>
            </div>
          </div>
        ) : null
      }
    />
  );
}
