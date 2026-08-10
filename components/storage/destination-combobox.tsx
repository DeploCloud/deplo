"use client";

import * as React from "react";
import { AlertTriangle, ChevronsUpDown, Cloud, Loader2, Server } from "lucide-react";

import { Input } from "@/components/ui/input";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";
import { StatusBadge } from "@/components/shared/status-badge";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import type { DestinationStatus } from "@/lib/types";
import type { DestinationOption } from "@/lib/data/destinations";

/** The stored badge is only a starting point; this is what the live probe returns. */
interface LiveStatus {
  status: DestinationStatus;
  error: string | null;
}

/**
 * Don't re-probe if one finished this recently. A human can't perceive the
 * difference, and it stops a double-click or a stray focus/blur from firing two
 * rounds of bucket writes.
 */
const PROBE_MIN_INTERVAL_MS = 5_000;

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
 * Typing filters over BOTH the name and that location — searching "r2", an
 * account id or a server name finds the destination when nobody remembers what
 * it was called. Unlike the version fields, free text is not a value here: the
 * field resolves to a destination id or to nothing.
 */
export function DestinationCombobox({
  destinations,
  value,
  onChange,
  id,
  disabled,
  sameDiskServerId,
  sameDiskNoun = "app",
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
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const [live, setLive] = React.useState<Record<string, LiveStatus>>({});
  const [probing, setProbing] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // Refs, not state: the guard has to be readable synchronously inside the same
  // click that opens the menu, before any re-render.
  const probingRef = React.useRef(false);
  const lastProbeRef = React.useRef(0);

  const selected = destinations.find((d) => d.id === value) ?? null;
  const sameDisk =
    !!sameDiskServerId &&
    selected?.kind === "server" &&
    selected.serverId === sameDiskServerId;

  /** Re-probe every destination and repaint the badges from the verdicts. */
  const probe = React.useCallback(() => {
    if (probingRef.current) return;
    if (Date.now() - lastProbeRef.current < PROBE_MIN_INTERVAL_MS) return;
    probingRef.current = true;
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
        probingRef.current = false;
        lastProbeRef.current = Date.now();
        setProbing(false);
      });
  }, []);

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setHighlight(0);
    probe();
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  // Close on outside click — the menu lives inside a dialog, so it must not
  // swallow the click that lands on another field.
  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      destinations.filter(
        (d) =>
          !q ||
          d.name.toLowerCase().includes(q) ||
          d.where.toLowerCase().includes(q),
      ),
    [destinations, q],
  );
  // Guard a stale index after the list shrinks, so Enter never picks past the end.
  const activeIndex = highlight < filtered.length ? highlight : 0;

  function choose(d: DestinationOption) {
    onChange(d.id);
    close();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      openMenu();
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length > 0) setHighlight((h) => (h + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length > 0)
        setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      // Swallowed even with nothing to pick: the dialog's submit must not fire
      // from inside an open menu.
      e.preventDefault();
      if (filtered.length > 0) choose(filtered[activeIndex]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={id ? `${id}-listbox` : undefined}
        aria-autocomplete="list"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        // Open shows what you are typing; closed shows what you picked.
        value={open ? query : (selected?.name ?? "")}
        placeholder={
          open ? (selected?.name ?? "Search destinations") : "Select a destination"
        }
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
          if (!open) openMenu();
        }}
        onFocus={() => {
          // A dialog placing focus here as it opens is Radix, not the user —
          // and it is not a reason to unfurl the menu or probe every bucket.
          if (isOverlayAutoFocusing()) return;
          openMenu();
        }}
        onMouseDown={() => {
          if (!open) openMenu();
        }}
        onKeyDown={onKeyDown}
        className="pr-9"
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
        {probing ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <ChevronsUpDown className="size-4" />
        )}
      </span>

      {open && (
        <div
          id={id ? `${id}-listbox` : undefined}
          role="listbox"
          className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {destinations.length === 0
                ? "No backup destinations yet"
                : "No destination matches that"}
            </p>
          ) : (
            <ul className="max-h-72 overflow-auto p-1">
              {filtered.map((d, i) => {
                const status = live[d.id]?.status ?? d.status;
                const error = live[d.id]?.error ?? null;
                return (
                  <li key={d.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={d.id === value}
                      onMouseEnter={() => setHighlight(i)}
                      // mousedown, not click: the input's blur would otherwise
                      // close the menu before the click landed.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(d);
                      }}
                      className={cn(
                        "w-full space-y-0.5 rounded-sm px-2 py-1.5 text-left",
                        i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
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
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Same-disk honesty, only once it is actually the choice. Rendered after
          the menu so the menu keeps its static position under the input. */}
      {sameDisk && selected && (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-[var(--warning)]">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>
            {selected.name} is on the same disk as this {sameDiskNoun}: protects
            against a mistake, not against a disk failure.
          </span>
        </p>
      )}
    </div>
  );
}
