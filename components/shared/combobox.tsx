"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronsUpDown, Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";
import { cn } from "@/lib/utils";

/**
 * Pick one thing out of a list by typing — the shell, with no opinion about what
 * the things are. Free text is never a value: the field resolves to one of `items`
 * or to nothing.
 */
export function Combobox<T>({
  items,
  value,
  onChange,
  getKey,
  matches,
  renderOption,
  renderLeading,
  renderTrailing,
  displayValue,
  selectable,
  id,
  autoFocus = false,
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
   * An affordance at the RIGHT EDGE of a row — a link out to the thing, say.
   */
  renderTrailing?: (item: T) => React.ReactNode;
  /**
   * Which items can actually be chosen.
   */
  selectable?: (item: T) => boolean;
  /**
   * A mark for the SELECTED item, drawn inside the field to the left of the text —
   * an app's own icon, say.
   */
  renderLeading?: (item: T) => React.ReactNode;
  /** What the closed field shows for the selection. */
  displayValue: (item: T) => string;
  id?: string;
  /** Put the cursor in the field on mount WITHOUT unfurling the menu: a page
   *  whose whole job is this one field (`/logs`) wants to be typed into, not
   *  covered by its own dropdown before anyone has asked for it. */
  autoFocus?: boolean;
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
  // The focus `autoFocus` places is not a user gesture, so it must not open the
  // menu — the same distinction `isOverlayAutoFocusing` draws for a dialog.
  const autoFocused = React.useRef(autoFocus);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const fieldRef = React.useRef<HTMLDivElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);

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

  /**
   * Where the menu goes, and into which element.
   */
  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [rect, setRect] = React.useState<{
    left: number;
    top: number;
    width: number;
    flipped: boolean;
  } | null>(null);

  React.useLayoutEffect(() => {
    // Left as it was while closed rather than cleared: the menu only renders
    // when `open`, and this effect re-measures before the next paint, so a stale
    // rect is never on screen.
    if (!open) return;
    const target =
      fieldRef.current?.closest<HTMLElement>(
        "[role='dialog'], [role='alertdialog']",
      ) ?? document.body;
    setHost(target);
    const place = () => {
      const el = fieldRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Offsets are relative to the portal host unless that host IS the body,
      // where the viewport's own coordinates are already what `fixed` wants.
      const o =
        target === document.body ? null : target.getBoundingClientRect();
      // The menu's own cap (max-h-72) plus its gap, so the decision to flip is
      // made against the room it will actually ask for.
      const wanted = 288 + 8;
      const below = window.innerHeight - r.bottom;
      const flipped = below < wanted && r.top > below;
      setRect({
        left: r.left - (o?.left ?? 0),
        // Flipped, the menu is pulled up by its own height with a transform —
        // cheaper and more honest than measuring it to compute a `bottom`.
        top: (flipped ? r.top - 4 : r.bottom + 4) - (o?.top ?? 0),
        width: r.width,
        flipped,
      });
    };
    place();
    // Capture, so a scroll INSIDE any ancestor moves the menu with its field and
    // not only a scroll of the page.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Escape closes the MENU, and only the menu. Without this, the first Escape meant
  // to shut a dropdown closed the whole wizard and threw away every answer in it.
  React.useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      setQuery("");
    }
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open]);

  // Close on outside click — the menu lives inside a dialog, so it must not
  // swallow the click that lands on another field.
  React.useEffect(() => {
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      // The menu is portaled, so it is NOT a descendant of the container — a
      // press on an option would otherwise read as a press outside the field.
      if (menuRef.current?.contains(target)) return;
      if (containerRef.current && !containerRef.current.contains(target)) {
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
  // The indices that can actually be landed on. Also guards a stale index after
  // the list shrinks, so Enter never picks past the end — or a heading.
  const pickable = React.useMemo(() => {
    const out: number[] = [];
    filtered.forEach((item, i) => {
      if (!selectable || selectable(item)) out.push(i);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered]);
  const activeIndex = pickable.includes(highlight)
    ? highlight
    : (pickable[0] ?? -1);

  // Keep the highlighted row in view: a tree is taller than the menu, and the
  // arrow keys walking off the bottom of it look like nothing is happening.
  const activeRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (open) activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  function step(delta: number) {
    if (pickable.length === 0) return;
    const at = pickable.indexOf(activeIndex);
    const next =
      at === -1
        ? delta > 0
          ? 0
          : pickable.length - 1
        : (at + delta + pickable.length) % pickable.length;
    setHighlight(pickable[next]!);
  }

  function choose(item: T) {
    if (selectable && !selectable(item)) return;
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
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter") {
      // Swallowed even with nothing to pick: the dialog's submit must not fire
      // from inside an open menu.
      e.preventDefault();
      if (activeIndex >= 0) choose(filtered[activeIndex]!);
    } else if (e.key === "Tab") {
      close();
    }
  }

  return (
    <div ref={containerRef}>
      {/**
       * The positioning context is the FIELD, not the field plus whatever the caller
       * hangs under it: the chevron is centred with `top-1/2`, so a footer inside this
       * box would drag it down into that text and leave the input looking like a broken
       */}
      <div ref={fieldRef} className="relative">
        {selected && renderLeading && (
          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2">
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
          autoFocus={autoFocus}
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
            // Open FIRST, then set the query: `openMenu` clears it, so doing it
            // the other way round swallowed the character that opened the menu.
            // With the field autofocused, that is every first keystroke.
            const typed = e.target.value;
            if (!open) openMenu();
            setQuery(typed);
            setHighlight(0);
          }}
          onFocus={() => {
            // A dialog placing focus here as it opens is Radix, not the user —
            // and it is not a reason to unfurl the menu or probe every bucket.
            if (isOverlayAutoFocusing()) return;
            if (autoFocused.current) {
              autoFocused.current = false;
              return;
            }
            openMenu();
          }}
          onMouseDown={() => {
            if (!open) openMenu();
          }}
          onKeyDown={onKeyDown}
          className={cn("pr-9", selected && renderLeading && "pl-9")}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground">
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <ChevronsUpDown className="size-4" />
          )}
        </span>

        {open &&
          rect &&
          host &&
          createPortal(
            <div
              ref={menuRef}
              id={id ? `${id}-listbox` : undefined}
              role="listbox"
              className={cn(
                "z-[60] overflow-hidden rounded-md border border-border bg-popover shadow-md",
                // Absolute against the dialog it was portaled into; `fixed` only
                // in the bodyless case, where the viewport IS the reference.
                host === document.body ? "fixed" : "absolute",
                rect.flipped && "-translate-y-full",
              )}
              style={{ left: rect.left, top: rect.top, width: rect.width }}
            >
              {filtered.length === 0 ? (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  {emptyLabel(items.length > 0)}
                </p>
              ) : (
                <ul className="max-h-72 overflow-auto p-1">
                  {filtered.map((item, i) => {
                    if (selectable && !selectable(item))
                      // A heading: drawn, never landed on. Not a button and not
                      // an option, so the keyboard and the screen reader agree
                      // with the pointer about what can be picked.
                      return (
                        <li key={getKey(item)} role="presentation">
                          {renderOption(item)}
                        </li>
                      );
                    const trailing = renderTrailing?.(item);
                    return (
                      <li key={getKey(item)} className="relative">
                        <button
                          type="button"
                          role="option"
                          ref={i === activeIndex ? activeRef : undefined}
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
                            trailing && "pr-9",
                            i === activeIndex
                              ? "bg-accent"
                              : "hover:bg-accent/60",
                          )}
                        >
                          {renderOption(item)}
                        </button>
                        {trailing ? (
                          // On top of the row, not in it: the button fills the
                          // width so the whole row still picks the item.
                          <span className="absolute top-1/2 right-1.5 -translate-y-1/2">
                            {trailing}
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>,
            host,
          )}
      </div>

      {/* Outside the field's positioning box on purpose (see above), so anything
          the caller hangs here can be as tall as it needs to be. */}
      {footer}
    </div>
  );
}
