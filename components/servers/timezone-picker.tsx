"use client";

import * as React from "react";
import { Check, ChevronDown, Globe, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The timezone picker on a server's Advanced tab.
 *
 * A `<datalist>` used to do this job and looked like the browser's, not like
 * Deplo's: no theme, no hover, no way to show what a zone means. This is the
 * same idea in the app's own vocabulary: a Popover with a search box and a list
 * that shows the CURRENT TIME in each zone, which is the thing an operator is
 * actually picking by ("the one that reads 14:32", not "the one spelled Rome").
 *
 * The zone list is the browser's own IANA database, nothing to ship, nothing to
 * keep up to date. Matches are capped (see MAX_ROWS) so a first open renders a
 * screenful rather than four hundred rows.
 */
const MAX_ROWS = 80;

/** The canonical IANA zones, from the platform. Static, so computed once. */
function allTimezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

/** One formatter per zone, reused across renders. Constructing them is the
 *  expensive half of showing a live clock next to every row. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function timeIn(zone: string, at: number): string {
  let fmt = formatters.get(zone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
    formatters.set(zone, fmt);
  }
  return fmt.format(at);
}

export function TimezonePicker({
  id,
  value,
  onChange,
  disabled,
  /** The instant the rows show the time at: the server's clock, so the list
   *  reads in the host's terms rather than the browser's. */
  now,
}: {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  now: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const zones = React.useMemo(() => allTimezones(), []);
  const listRef = React.useRef<HTMLDivElement>(null);

  const { matches, hidden } = React.useMemo(() => {
    const q = query.trim().toLowerCase().replace(/\s+/g, "_");
    const hits = q ? zones.filter((z) => z.toLowerCase().includes(q)) : zones;
    return { matches: hits.slice(0, MAX_ROWS), hidden: Math.max(0, hits.length - MAX_ROWS) };
  }, [zones, query]);

  function pick(zone: string) {
    onChange(zone);
    setOpen(false);
    setQuery("");
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next = e.key === "ArrowDown" ? i + 1 : i - 1;
        const clamped = Math.max(0, Math.min(matches.length - 1, next));
        listRef.current
          ?.querySelectorAll("[data-zone-row]")
          [clamped]?.scrollIntoView({ block: "nearest" });
        return clamped;
      });
      return;
    }
    if (e.key === "Enter" && matches[active]) {
      e.preventDefault();
      pick(matches[active]);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery("");
          setActive(0);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full max-w-sm justify-between font-normal"
        >
          <span className="flex min-w-0 items-center gap-2">
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{value || "Pick a timezone"}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(24rem,calc(100vw-2rem))] p-0"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search a city or region"
            className="h-10 border-0 px-0 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No timezone matches that
            </p>
          ) : (
            matches.map((zone, i) => (
              <button
                key={zone}
                type="button"
                data-zone-row
                onClick={() => pick(zone)}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm",
                  i === active ? "bg-accent text-accent-foreground" : "",
                )}
              >
                <Check
                  className={cn(
                    "size-4 shrink-0",
                    zone === value ? "opacity-100" : "opacity-0",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{zone.replace(/_/g, " ")}</span>
                <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {timeIn(zone, now)}
                </span>
              </button>
            ))
          )}
          {hidden > 0 ? (
            <p className="px-2 py-2 text-center text-xs text-muted-foreground">
              {hidden} more, keep typing to narrow it down
            </p>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
