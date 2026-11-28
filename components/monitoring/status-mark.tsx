import { cn } from "@/lib/utils";

export type StatusTone = "ok" | "warn" | "bad";

const COLOR: Record<StatusTone, string> = {
  ok: "var(--green)",
  warn: "var(--warning)",
  bad: "var(--destructive)",
};

// A disc that pops in, draws its check (or "!"), then keeps two rings rippling out of it.
export function StatusMark({
  tone,
  className,
}: {
  tone: StatusTone;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative grid size-20 shrink-0 place-items-center",
        className,
      )}
      style={{ color: COLOR[tone] }}
    >
      <span className="status-ripple absolute inset-[18%] rounded-full border-2 border-current" />
      <span className="status-ripple status-ripple-late absolute inset-[18%] rounded-full border-2 border-current" />
      <svg viewBox="0 0 80 80" className="relative size-full overflow-visible">
        <circle
          cx="40"
          cy="40"
          r="30"
          style={{ fill: `color-mix(in srgb, currentColor 16%, var(--card))` }}
        />
        <g className="status-pop">
          <circle cx="40" cy="40" r="22" fill="currentColor" />
          <path
            d={tone === "ok" ? "M30 41l7 7 14-15" : "M40 29v13M40 51v.5"}
            pathLength={1}
            className="status-draw"
            fill="none"
            stroke="var(--background)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </span>
  );
}
