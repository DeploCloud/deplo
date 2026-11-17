"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface RowItem {
  key: string;
  node: React.ReactNode;
}

/** How many items fit in `width`, keeping room for the +N chip whenever one is left out. */
export function fitting(
  width: number,
  widths: number[],
  gap: number,
  plus: number,
): number {
  let used = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + (i ? gap : 0) + widths[i];
    const room = i === widths.length - 1 ? 0 : gap + plus;
    if (next + room > width) return i;
    used = next;
  }
  return widths.length;
}

/** Items on one row; the ones that do not fit fold into a +N chip that shows them on hover. */
export function OneRow({
  items,
  className,
}: {
  items: RowItem[];
  className?: string;
}) {
  const rowRef = React.useRef<HTMLDivElement>(null);
  const probeRef = React.useRef<HTMLDivElement>(null);
  const [fit, setFit] = React.useState(items.length);
  const signature = items.map((i) => i.key).join(" ");

  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const probe = probeRef.current;
    if (!row || !probe) return;
    const measure = () => {
      const widths = [...probe.children].map(
        (c) => (c as HTMLElement).offsetWidth,
      );
      const plus = widths.pop() ?? 0;
      const gap = parseFloat(getComputedStyle(probe).columnGap) || 0;
      setFit(fitting(row.clientWidth, widths, gap, plus));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [signature]);

  const hidden = items.slice(fit);
  return (
    <div
      ref={rowRef}
      className={cn(
        "relative flex min-w-0 items-center gap-1.5 overflow-hidden [&>*]:shrink-0",
        className,
      )}
    >
      {items.slice(0, fit).map((i) => (
        <React.Fragment key={i.key}>{i.node}</React.Fragment>
      ))}
      {hidden.length > 0 && (
        <SimpleTooltip
          content={
            <span className="flex max-w-xs flex-wrap gap-1.5">
              {hidden.map((i) => (
                <React.Fragment key={i.key}>{i.node}</React.Fragment>
              ))}
            </span>
          }
        >
          <Badge variant="muted" className="tabular-nums">
            +{hidden.length}
          </Badge>
        </SimpleTooltip>
      )}
      <div
        ref={probeRef}
        aria-hidden
        inert
        className="invisible absolute top-0 left-0 flex gap-1.5 whitespace-nowrap [&>*]:shrink-0"
      >
        {items.map((i) => (
          <React.Fragment key={i.key}>{i.node}</React.Fragment>
        ))}
        <Badge variant="muted">+{items.length}</Badge>
      </div>
    </div>
  );
}
