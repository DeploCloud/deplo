"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { ChevronsUpDown, Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";
import { cn } from "@/lib/utils";

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
  value: string;
  onChange: (key: string) => void;
  getKey: (item: T) => string;
  matches: (item: T, query: string) => boolean;
  renderOption: (item: T) => React.ReactNode;
  renderTrailing?: (item: T) => React.ReactNode;
  selectable?: (item: T) => boolean;
  renderLeading?: (item: T) => React.ReactNode;
  displayValue: (item: T) => string;
  id?: string;
  autoFocus?: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: (hasItems: boolean) => string;
  busy?: boolean;
  disabled?: boolean;
  onOpen?: () => void;
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

  const [host, setHost] = React.useState<HTMLElement | null>(null);
  const [rect, setRect] = React.useState<{
    left: number;
    top: number;
    width: number;
    flipped: boolean;
  } | null>(null);

  React.useLayoutEffect(() => {
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
      const o =
        target === document.body ? null : target.getBoundingClientRect();
      const wanted = 288 + 8;
      const below = window.innerHeight - r.bottom;
      const flipped = below < wanted && r.top > below;
      setRect({
        left: r.left - (o?.left ?? 0),
        top: (flipped ? r.top - 4 : r.bottom + 4) - (o?.top ?? 0),
        width: r.width,
        flipped,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    function onEscape(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (autoFocus) return;
      e.stopPropagation();
      setOpen(false);
      setQuery("");
    }
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [open, autoFocus]);

  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = React.useMemo(
    () => items.filter((i) => !q || matches(i, q)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, q],
  );
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
      e.preventDefault();
      if (activeIndex >= 0) choose(filtered[activeIndex]!);
    } else if (e.key === "Tab") {
      close();
    }
  }

  return (
    <div ref={containerRef}>
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
          value={open ? query : selected ? displayValue(selected) : ""}
          placeholder={
            open
              ? selected
                ? displayValue(selected)
                : searchPlaceholder
              : placeholder
          }
          onChange={(e) => {
            const typed = e.target.value;
            if (!open) openMenu();
            setQuery(typed);
            setHighlight(0);
          }}
          onFocus={() => {
            if (isOverlayAutoFocusing()) return;
            if (!open) openMenu();
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
                          onMouseDown={(e) => {
                            e.preventDefault();
                            choose(item);
                          }}
                          className={cn(
                            "w-full space-y-0.5 rounded-sm px-2 py-1.5 text-left",
                            trailing && "pr-9",
                            i === activeIndex
                              ? "bg-accent"
                              : "hover:bg-surface-strong",
                          )}
                        >
                          {renderOption(item)}
                        </button>
                        {trailing ? (
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

      {footer}
    </div>
  );
}
