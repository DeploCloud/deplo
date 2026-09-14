"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { FacetClearRow, FacetOptionList, toggleValue } from "./facet-options";
import { facetSummary, facetTitle } from "./facet-summary";
import type { EnvFacet } from "./types";

// FacetCombobox is the `searchable` facet control: the value is always the needle,
// so what you typed and what is picked never fight over the same box.
export function FacetCombobox<T>({
  facet,
  values,
  counts,
  onChange,
}: {
  facet: EnvFacet<T>;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
}) {
  const Icon = facet.icon;
  const baseId = React.useId();
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  // The autocomplete needle. Reset on close so the menu reopens whole - a stale
  // needle would read as options having vanished.
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const on = values.length > 0;
  const empty = facet.options.length === 0;

  const needle = query.trim().toLowerCase();
  // Never hide a TICKED option: unticking must stay one click away even when the
  // needle no longer matches it.
  const shownOptions = needle
    ? facet.options.filter(
        (o) =>
          values.includes(o.value) ||
          `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle),
      )
    : facet.options;

  // Index 0 is the clear row; the options follow. Clamp instead of resetting so
  // the highlight survives the list shrinking under a longer needle.
  const rowCount = shownOptions.length + 1;
  const activeIndex = Math.min(active, rowCount - 1);
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  React.useEffect(() => {
    if (!open) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
    // optionId is render-stable (useId); only the highlight moves the scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function toggle(value: string) {
    onChange(toggleValue(values, value));
    // A row is a <label> whose activation forwards to the checkbox button -
    // reclaim the caret so the next keystroke keeps narrowing.
    inputRef.current?.focus();
  }

  // The menu STAYS open on a pick - this is a multi-select, one pick is rarely the last.
  function pick(index: number) {
    if (index === 0) {
      onChange([]);
      inputRef.current?.focus();
      return;
    }
    const opt = shownOptions[index - 1];
    if (opt) toggle(opt.value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive(
        e.key === "ArrowDown"
          ? Math.min(activeIndex + 1, rowCount - 1)
          : Math.max(activeIndex - 1, 0),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) pick(activeIndex);
      else setOpen(true);
    } else if (e.key === "Tab") {
      // Let the Tab through - just don't leave a menu floating behind it.
      close();
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
    >
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative min-w-0 flex-1">
          {Icon && (
            <Icon
              className={cn(
                "pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2",
                on ? "text-foreground" : "text-muted-foreground",
              )}
            />
          )}
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${baseId}-listbox`}
            aria-autocomplete="list"
            aria-activedescendant={open ? optionId(activeIndex) : undefined}
            aria-label={`Filter by ${facet.label.toLowerCase()}`}
            title={facetTitle(facet, values)}
            disabled={empty}
            value={query}
            placeholder={facetSummary(facet, values)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={cn(
              "h-9 pr-8",
              Icon ? "pl-8" : "pl-3",
              // An active filter wears the same tint as an active FacetMenu
              // button, and its summary-as-placeholder reads as a VALUE, not a
              // hint - it is what the filter is doing right now.
              on &&
                "border-primary/60 bg-primary-wash placeholder:text-foreground",
            )}
          />
          <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 opacity-50" />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="min-w-64 p-1"
        style={{ width: "var(--radix-popper-anchor-width)" }}
        // Focus lives in the input for the combobox's whole life: never yank it into the
        // menu on open, never fling it elsewhere on close, and don't treat clicks on the
        // input (the ANCHOR - outside the content) as a dismissal.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        // Escape backs out one layer at a time: a needle is cleared, an empty
        // box is closed.
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery("");
            setActive(0);
          }
        }}
      >
        <div
          id={`${baseId}-listbox`}
          role="listbox"
          aria-multiselectable="true"
        >
          <FacetClearRow
            label={facet.allLabel}
            on={on}
            onSelect={() => pick(0)}
            id={optionId(0)}
            active={activeIndex === 0}
            onActivate={() => setActive(0)}
          />
          <div aria-hidden className="my-1 h-px bg-border" />
          <FacetOptionList
            options={shownOptions}
            values={values}
            counts={counts}
            onChange={onChange}
            onToggle={toggle}
            optionId={optionId}
            activeIndex={activeIndex}
            onActivate={setActive}
            empty={
              shownOptions.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No match for “{query.trim()}”.
                </p>
              )
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
