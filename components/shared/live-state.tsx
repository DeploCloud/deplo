"use client";

import * as React from "react";
import { Check, Loader2 } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

// What a screen shows while something takes time: its steps with the current one marked, and a countdown
// where the wait has a known length. Both update by themselves.

/** Calls fn every `ms` while the page is visible, and once at once when it comes back. */
export function useEvery(ms: number, fn: () => void, on = true): void {
  const ref = React.useRef(fn);
  React.useEffect(() => {
    ref.current = fn;
  });
  React.useEffect(() => {
    if (!on) return;
    const tick = () => {
      if (document.visibilityState === "visible") ref.current();
    };
    const id = window.setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms, on]);
}

/** The time now, ticking every second while `on`. */
export function useNow(on = true): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [on]);
  return now;
}

export type LiveStep = { label: string; state: "done" | "current" | "todo" };

/** A short row of steps: done ones ticked, the current one spinning, the rest waiting. */
export function LiveSteps({
  steps,
  className,
}: {
  steps: LiveStep[];
  className?: string;
}) {
  return (
    <ol
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-xs",
        className,
      )}
      aria-label="Progress"
    >
      {steps.map((s) => (
        <li
          key={s.label}
          aria-current={s.state === "current" ? "step" : undefined}
          className={cn(
            "flex items-center gap-1",
            s.state === "todo" ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {s.state === "done" ? (
            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          ) : s.state === "current" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <span className="size-3.5 rounded-full border border-border" />
          )}
          {s.label}
        </li>
      ))}
    </ol>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A wait of known length: a bar that fills, and the time left as m:ss. */
export function Countdown({
  until,
  total,
  label,
}: {
  until: string | number;
  total: number;
  label: string;
}) {
  const end = typeof until === "number" ? until : Date.parse(until);
  const now = useNow(Number.isFinite(end));
  const left = Math.max(0, end - now);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums" aria-live="polite">
          {left > 0 ? `${clock(left)} left` : "any moment"}
        </span>
      </div>
      <Progress
        value={total > 0 ? Math.min(100, ((total - left) / total) * 100) : 100}
        className="h-1.5"
        aria-label={label}
      />
    </div>
  );
}
