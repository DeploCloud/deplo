"use client";

import * as React from "react";
import { ChevronDown, Check, LayoutGrid } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CategoryIcon } from "@/components/templates/category-icon";
import { cn } from "@/lib/utils";

export interface ChipCategory {
  slug: string;
  name: string;
  icon: string;
  count: number;
}

/** `gap-2`, in pixels - the fit arithmetic has to know the gap it is spending. */
const GAP = 8;
/** Tailwind's `sm`. Below it the row scrolls and nothing is hidden. */
const DESKTOP = 640;
/** Reserved for the "More" trigger until it has been measured for real. */
const MORE_FALLBACK = 96;

/**
 * The category filter. A scrolling row on a phone, where the thumb already
 * swipes; on desktop the chips that fit stay chips and the rest fold into
 * "More", which also keeps the row exactly one line tall at every width.
 */
export function CategoryChips({
  categories,
  active,
  onSelect,
}: {
  categories: ChipCategory[];
  /** Selected category slug, or "" for All. */
  active: string;
  onSelect: (slug: string) => void;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const moreRef = React.useRef<HTMLButtonElement>(null);
  // Measured once, while every chip is still in the DOM, and reused after the
  // row has been trimmed - a hidden chip can no longer report its own width.
  const widths = React.useRef<number[] | null>(null);
  // null = show everything (the first paint, and every phone).
  const [fits, setFits] = React.useState<number | null>(null);

  const measure = React.useCallback(() => {
    const row = rowRef.current;
    if (!row) return;

    if (widths.current === null) {
      const chips = row.querySelectorAll<HTMLElement>("[data-chip]");
      if (chips.length !== categories.length) return; // not laid out yet
      widths.current = [...chips].map((c) => c.getBoundingClientRect().width);
    }
    const all = widths.current;

    if (window.innerWidth < DESKTOP) {
      setFits(null); // the row scrolls; every chip stays reachable
      return;
    }

    // The All chip is not optional, it is how you clear the filter, so the
    // budget starts after it.
    const allChip = row.querySelector<HTMLElement>("[data-all-chip]");
    const budget =
      row.clientWidth - (allChip?.getBoundingClientRect().width ?? 0) - GAP;

    const countThatFit = (available: number) => {
      let used = 0;
      let n = 0;
      for (const w of all) {
        const next = used + (n ? GAP : 0) + w;
        if (next > available) break;
        used = next;
        n += 1;
      }
      return n;
    };

    const loose = countThatFit(budget);
    if (loose >= all.length) {
      setFits(null);
      return;
    }
    // Something has to fold, so the trigger has to be paid for too.
    const moreWidth =
      moreRef.current?.getBoundingClientRect().width ?? MORE_FALLBACK;
    setFits(Math.max(0, countThatFit(budget - GAP - moreWidth)));
  }, [categories.length]);

  React.useEffect(() => {
    // Next frame, not this one: the first measurement has to read a laid-out
    // row, and measuring straight from the effect would also set state inside
    // the render that scheduled it.
    const frame = requestAnimationFrame(measure);
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined")
      return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [measure]);

  let shown = fits === null ? categories : categories.slice(0, fits);
  let hidden = fits === null ? [] : categories.slice(fits);

  // A filter you cannot see you applied is worse than one chip fewer: if the
  // selection folded into the menu, trade the last visible chip for it.
  const activeHidden = active && hidden.some((c) => c.slug === active);
  if (activeHidden) {
    const picked = hidden.find((c) => c.slug === active)!;
    shown = [...shown.slice(0, Math.max(0, shown.length - 1)), picked];
    hidden = categories.filter((c) => !shown.includes(c));
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "flex items-center gap-2",
        // Phone: one scrolling line, no bar. Desktop: nothing overflows, so
        // there is nothing to scroll.
        fits === null
          ? "-mx-1 scrollbar-none overflow-x-auto px-1 pb-1"
          : "min-w-0",
      )}
    >
      <Chip
        data-all-chip
        active={!active}
        onClick={() => onSelect("")}
        label="All"
        icon={<LayoutGrid className="size-3.5 shrink-0" />}
      />
      {shown.map((c) => (
        <Chip
          key={c.slug}
          data-chip
          active={active === c.slug}
          onClick={() => onSelect(active === c.slug ? "" : c.slug)}
          label={c.name}
          icon={<CategoryIcon icon={c.icon} className="size-3.5 shrink-0" />}
        />
      ))}

      {hidden.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              ref={moreRef}
              type="button"
              className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              More
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
            {hidden.map((c) => (
              <DropdownMenuItem
                key={c.slug}
                onSelect={() => onSelect(active === c.slug ? "" : c.slug)}
                className="gap-2"
              >
                <CategoryIcon icon={c.icon} className="size-4 shrink-0" />
                <span className="flex-1">{c.name}</span>
                <span className="text-xs text-muted-foreground">{c.count}</span>
                {active === c.slug && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  icon,
  ...props
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        active
          ? "border-primary/60 bg-primary/[0.06] text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
      {...props}
    >
      {icon}
      {label}
    </button>
  );
}
