"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A free-text input with a lazy autocomplete dropdown, backing the "pick a
 * builder/runtime version" fields in build settings. Shared by
 * {@link RailpackVersionInput} and {@link NodeVersionInput} so the two behave
 * identically — they differ only in what they load and their placeholder.
 *
 * Free-text is always allowed: the field accepts anything the user types, and
 * the dropdown is only a hint synced from an upstream release list. Items load
 * lazily on first focus, so the network call happens only when the field opens.
 *
 * Items are `{ value, label }`: `value` is what round-trips through the form
 * (what gets stored/pinned); `label` is what the dropdown shows. For lists whose
 * display equals their stored value (e.g. railpack tags), pass value === label.
 */
export interface VersionItem {
  value: string;
  label: string;
}

export interface VersionComboboxProps {
  value: string;
  onChange: (value: string) => void;
  /** Fetch the suggestion list once, lazily, on first focus. */
  load: () => Promise<VersionItem[]>;
  placeholder?: string;
  id?: string;
  className?: string;
}

export function VersionCombobox({
  value,
  onChange,
  load,
  placeholder,
  id,
  className,
}: VersionComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<VersionItem[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const loadedRef = React.useRef(false);

  // Fetch the suggestion list once, on first focus (lazy — no call until opened).
  const runLoad = React.useCallback(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    load()
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => {
        // Leave the list empty; the field still accepts free text.
      })
      .finally(() => setLoading(false));
  }, [load]);

  // Filter by what's typed (case-insensitive substring over value AND label).
  const q = value.trim().toLowerCase();
  const filtered = React.useMemo(
    () =>
      items.filter(
        (it) =>
          !q ||
          it.value.toLowerCase().includes(q) ||
          it.label.toLowerCase().includes(q),
      ),
    [items, q],
  );
  // Guard against a stale index after the list shrinks (e.g. more typing) so the
  // Enter key never selects past the end.
  const activeIndex = highlight < filtered.length ? highlight : 0;

  // Close the dropdown on outside click.
  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function choose(it: VersionItem) {
    onChange(it.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(filtered[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => {
          runLoad();
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn("pr-9 font-mono text-xs", className)}
      />
      {loading && (
        <Loader2 className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      )}

      {open && (loading || filtered.length > 0) && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          {loading && filtered.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading versions…
            </div>
          )}
          {filtered.length > 0 && (
            <ul className="max-h-72 overflow-auto p-1">
              {filtered.map((it, i) => (
                <li key={it.value}>
                  <button
                    type="button"
                    onMouseEnter={() => setHighlight(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(it);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-xs",
                      i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                    )}
                  >
                    {it.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
