"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { titleClass } from "@/components/shared/page-header";

/** How far the row fades out on the side that has more to show. */
const FADE = "56px";

/**
 * A row of cards that scrolls sideways. Native overflow and CSS scroll snap, no
 * carousel; `ScrollArea` takes no orientation and mounts a vertical scrollbar.
 * The arrows are for the mouse and only appear where there is somewhere to go. */
export function TemplateRail({
  title,
  subtitle,
  icon,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  /** A way out of the row when its cards are a slice of something bigger. */
  action?: React.ReactNode;
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

  // Masked, not overlaid: a gradient in the page's own colour would be a fill
  // nobody chose, and the row sits on two different surfaces. RIGHT ONLY - the
  // left edge is where a card starts, and a card cut by a fade reads as broken.
  const mask = edges.right
    ? `linear-gradient(to right, black calc(100% - ${FADE}), transparent 100%)`
    : undefined;

  return (
    <section className="group/rail space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className={cn("flex items-center gap-2", titleClass.section)}>
            {icon}
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {action}
          <div className="hidden items-center gap-1 sm:flex">
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
      </div>

      <div
        ref={ref}
        onScroll={measure}
        style={{ maskImage: mask, WebkitMaskImage: mask }}
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
