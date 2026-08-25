"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A row of cards that scrolls sideways. Native overflow and CSS scroll snap, no
 * carousel; `ScrollArea` takes no orientation and mounts a vertical scrollbar.
 * The arrows are for the mouse and only appear where there is somewhere to go. */
export function TemplateRail({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel layout leaves scrollLeft a hair short of the end
    // and would keep the right arrow lit on a fully scrolled row.
    setEdges({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  React.useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  const scroll = (direction: -1 | 1) => {
    const el = ref.current;
    if (el)
      el.scrollBy({
        left: direction * el.clientWidth * 0.8,
        behavior: "smooth",
      });
  };

  return (
    <section className="group/rail space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold tracking-tight lg:text-lg">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="hidden shrink-0 items-center gap-1 sm:flex">
          <RailArrow
            direction={-1}
            enabled={edges.left}
            onClick={() => scroll(-1)}
          />
          <RailArrow
            direction={1}
            enabled={edges.right}
            onClick={() => scroll(1)}
          />
        </div>
      </div>

      <div
        ref={ref}
        onScroll={measure}
        className="-mx-1 scrollbar-none flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 py-1"
      >
        {children}
      </div>
    </section>
  );
}

function RailArrow({
  direction,
  enabled,
  onClick,
}: {
  direction: -1 | 1;
  enabled: boolean;
  onClick: () => void;
}) {
  const Icon = direction === -1 ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      aria-label={direction === -1 ? "Scroll left" : "Scroll right"}
      className={cn(
        "flex size-8 items-center justify-center rounded-md border border-border text-muted-foreground transition",
        "hover:text-foreground focus-visible:opacity-100",
        // Idle rows stay quiet: the arrows fade in with the row, and an edge
        // with nothing behind it never lights up at all.
        enabled
          ? "opacity-0 group-hover/rail:opacity-100"
          : "cursor-default opacity-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
