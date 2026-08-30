"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

/** A panel body caps here so its footer stays on screen and the whole modal
 *  stays inside its 85vh box - the chrome (header + tabs + footer) is ~14rem. */
export const PANEL_BODY_MAX = "max-h-[calc(85vh-14rem)]";

/** The same, for a track nested INSIDE a panel of another one: the chrome is a
 *  back row and a second header taller (measured 276px), so the outer 14rem
 *  allowance overflows the modal and clips the inner footer. */
export const PANEL_BODY_MAX_NESTED = "max-h-[calc(85vh-18rem)]";

/**
 * Panels on ONE horizontal track that slides between them, with the viewport's
 * height easing to whichever panel is showing - so the slide glides instead of
 * jumping. Every panel stays mounted (that is what makes the slide possible);
 * the ones off-screen are `inert`.
 */
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

  // Created once (lazy state init, so `new ResizeObserver` never runs on the
  // server); a single instance keeps every panel measured.
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

  // Measure on attach and observe for later size changes; unobserve on detach.
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
