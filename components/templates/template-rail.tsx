"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { titleClass } from "@/components/shared/page-header";

const FADE = "56px";

// TemplateRail - native overflow and scroll snap, because `ScrollArea` takes no orientation and mounts a vertical scrollbar.
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
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [edges, setEdges] = React.useState({ left: false, right: false });

  const measure = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px of slack: sub-pixel layout leaves scrollLeft short of the end and kept the right arrow lit on a fully scrolled row.
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

  // Masked, not overlaid (a gradient would be a fill nobody chose), and right only - a fade over the left edge cuts a card.
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
        enabled
          ? "opacity-0 group-hover/rail:opacity-100"
          : "cursor-default opacity-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}
