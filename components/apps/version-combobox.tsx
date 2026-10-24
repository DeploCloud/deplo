"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface VersionItem {
  value: string;
  label: string;
}

export interface VersionComboboxProps {
  value: string;
  onChange: (value: string) => void;
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

  const runLoad = React.useCallback(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    load()
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [load]);

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
  const activeIndex = highlight < filtered.length ? highlight : 0;

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

  // A portal, so a parent that clips (a collapsing drawer, a dialog) cannot cut the list off.
  return (
    <Popover
      open={open && (loading || filtered.length > 0)}
      onOpenChange={setOpen}
    >
      <PopoverAnchor asChild>
        <div ref={containerRef} className="relative w-full">
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
            <Loader2 className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        side="bottom"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (containerRef.current?.contains(e.target as Node))
            e.preventDefault();
        }}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
      >
        {loading && filtered.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading versions
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
                    i === activeIndex ? "bg-accent" : "hover:bg-surface-strong",
                  )}
                >
                  {it.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
