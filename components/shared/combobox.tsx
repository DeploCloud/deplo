"use client";

import * as React from "react";
import { ChevronsUpDown, Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";
import { cn } from "@/lib/utils";

/**
 * Pick one thing out of a list by typing — the shell, with no opinion about what
 * the things are.
 *
 * Everything here is behaviour rather than looks: the menu opens on focus but not
 * when a dialog placed that focus itself, selection lands on `mousedown` (a click
 * would arrive after the input's blur had already closed the menu), Enter is
 * swallowed whenever the menu is open so it can never submit the surrounding
 * form, and the highlight index is guarded against a list that shrank under it.
 * Each of those is a bug someone already found once, in the destination picker
 * this was lifted out of — which is the whole reason it is shared rather than
 * written a second time next to it.
 *
 * Free text is never a value: the field resolves to one of `items` or to nothing.
 */
export function Combobox<T>({
  items,
  value,
  onChange,
  getKey,
  matches,
  renderOption,
  renderLeading,
  displayValue,
  id,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  busy = false,
  disabled = false,
  onOpen,
  footer,
}: {
  items: T[];
  /** The selected key, or "" for none. */
  value: string;
  onChange: (key: string) => void;
  getKey: (item: T) => string;
  /** Whether `item` survives the typed query (already lower-cased, trimmed). */
  matches: (item: T, query: string) => boolean;
  renderOption: (item: T) => React.ReactNode;
  /**
   * A mark for the SELECTED item, drawn inside the field to the left of the
   * text — an app's own icon, say. Without it a picker shows you a logo per row
   * while you choose and then a bare name once you have, which reads as having
   * lost track of what you picked.
   */
  renderLeading?: (item: T) => React.ReactNode;
  /** What the closed field shows for the selection. */
  displayValue: (item: T) => string;
  id?: string;
  placeholder: string;
  searchPlaceholder: string;
  /** Shown when nothing matches; a function gets the query's emptiness. */
  emptyLabel: (hasItems: boolean) => string;
  /** Spinner instead of the chevron — work the caller kicked off in `onOpen`. */
  busy?: boolean;
  disabled?: boolean;
  /** Fired when the menu opens, e.g. to probe or refresh the list. */
  onOpen?: () => void;
  /** Rendered under the field, outside the menu (a warning about the choice). */
  footer?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [highlight, setHighlight] = React.useState(0);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const selected = items.find((i) => getKey(i) === value) ?? null;

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    setHighlight(0);
    onOpen?.();
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
    () => items.filter((i) => !q || matches(i, q)),
    // `matches` is a fresh closure on every render at most call sites; the list
    // and the query are what actually change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, q],
  );
  // Guard a stale index after the list shrinks, so Enter never picks past the end.
  const activeIndex = highlight < filtered.length ? highlight : 0;

  function choose(item: T) {
    onChange(getKey(item));
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
    <div ref={containerRef}>
      {/* The positioning context is the FIELD, not the field plus whatever the
          caller hangs under it: the chevron is centred with `top-1/2`, so a
          footer inside this box would drag it down into that text and leave the
          input looking like a broken control. */}
      <div className="relative">
        {selected && renderLeading && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2">
            {renderLeading(selected)}
          </span>
        )}
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
          value={open ? query : selected ? displayValue(selected) : ""}
          placeholder={
            open
              ? selected
                ? displayValue(selected)
                : searchPlaceholder
              : placeholder
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
          className={cn("pr-9", selected && renderLeading && "pl-9")}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {busy ? (
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
                {emptyLabel(items.length > 0)}
              </p>
            ) : (
              <ul className="max-h-72 overflow-auto p-1">
                {filtered.map((item, i) => (
                  <li key={getKey(item)}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={getKey(item) === value}
                      onMouseEnter={() => setHighlight(i)}
                      // mousedown, not click: the input's blur would otherwise
                      // close the menu before the click landed.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(item);
                      }}
                      className={cn(
                        "w-full space-y-0.5 rounded-sm px-2 py-1.5 text-left",
                        i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      {renderOption(item)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

      </div>

      {/* Outside the field's positioning box on purpose (see above), so anything
          the caller hangs here can be as tall as it needs to be. */}
      {footer}
    </div>
  );
}
