"use client";

import * as React from "react";

// PANEL_BODY_MAX - a panel body caps here so its footer stays inside the modal's 85vh box (chrome ~14rem).
export const PANEL_BODY_MAX = "max-h-[calc(85vh-14rem)]";

// PANEL_BODY_MAX_NESTED - the same for a nested track, whose chrome measures 276px, not 14rem.
export const PANEL_BODY_MAX_NESTED = "max-h-[calc(85vh-18rem)]";

// SlidingPanels - panels on one horizontal track; all stay mounted, the off-screen ones `inert`.
export function SlidingPanels<T extends string>({
  panels,
  current,
  render,
  labelFor,
}: {
  panels: readonly T[];
  current: T;
  render: (id: T) => React.ReactNode;
  labelFor?: (id: T) => string;
}) {
  const index = Math.max(0, panels.indexOf(current));

  const els = React.useRef<Partial<Record<T, HTMLElement | null>>>({});
  const [heights, setHeights] = React.useState<Partial<Record<T, number>>>({});
  const height = heights[current] || undefined;

  // Lazy state init, so `new ResizeObserver` never runs on the server.
  const [observer] = React.useState<ResizeObserver | null>(() =>
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver((entries) => {
          setHeights((prev) => {
            let next = prev;
            for (const entry of entries) {
              const el = entry.target as HTMLElement;
              const t = el.dataset.panel as T | undefined;
              if (t && next[t] !== el.offsetHeight)
                next = { ...next, [t]: el.offsetHeight };
            }
            return next;
          });
        }),
  );
  React.useEffect(() => () => observer?.disconnect(), [observer]);

  const registerPanel = React.useCallback(
    (t: T) => (el: HTMLElement | null) => {
      const prev = els.current[t];
      if (prev) observer?.unobserve(prev);
      els.current[t] = el;
      if (!el) return;
      const h = el.offsetHeight;
      setHeights((prevH) => (prevH[t] === h ? prevH : { ...prevH, [t]: h }));
      observer?.observe(el);
    },
    [observer],
  );

  return (
    <div
      className="relative overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none"
      style={{ height }}
    >
      <div
        className="flex transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: `translateX(-${index * 100}%)` }}
      >
        {panels.map((p) => (
          <div
            key={p}
            ref={registerPanel(p)}
            data-panel={p}
            role="group"
            aria-label={labelFor?.(p)}
            inert={p !== current ? true : undefined}
            className="w-full shrink-0 self-start"
          >
            {render(p)}
          </div>
        ))}
      </div>
    </div>
  );
}
