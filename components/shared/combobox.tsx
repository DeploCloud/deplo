"use client";

import * as React from "react";
import { createPortal } from "react-dom";
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
   *
   * PORTALED, because every dialog scrolls now (see `DialogContent`) and an
   * absolutely-positioned menu inside a scroll box is clipped by it — which
   * turned a two-field step into a scrolling one and cut the options off at the
   * fold. Radix's own Select and Popover portal for the same reason.
   *
   * Into the surrounding DIALOG, though, not the body. A modal Radix dialog sets
   * `pointer-events: none` on `<body>` and treats a press anywhere outside its
   * content as a dismiss, so a menu parked on the body was unclickable AND, had
   * it been clickable, would have closed the dialog under the click. Inside the
   * content it is a sibling of the scroll box: out of the clip, still in the
   * dialog. The content is `fixed` and transformed, which makes it the
   * containing block, so the offsets are measured against it.
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

  // Escape closes the MENU, and only the menu.
  //
  // On `window`, in the capture phase, because that is the only place early
  // enough: Radix's dialog listens for Escape on `document` (also capture), and
  // capture runs outermost-first, so a handler on the input itself — or anywhere
  // else inside the tree — is already too late. Without this, the first Escape
  // meant to shut a dropdown closed the whole wizard and threw away every answer
  // in it. One Escape closes the menu; the next, with no menu open, reaches the
  // dialog as usual.
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
      <div ref={fieldRef} className="relative">
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
