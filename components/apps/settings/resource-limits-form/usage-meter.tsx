"use client";

import { cn } from "@/lib/utils";

const THUMB = 16;

export function Meter({
  cap,
  used,
  full,
  step,
  label,
  valueText,
  onChange,
}: {
  cap: number | null;
  used: number | null;
  full: number;
  step: number;
  label: string;
  valueText: string;
  onChange: (value: number) => void;
}) {
  const pct = (n: number) => `${Math.min(100, (n / full) * 100)}%`;
  const overCap = cap != null && used != null && used > cap;
  return (
    <div className="relative flex h-4 items-center">
      <div
        className="relative h-2 flex-1 overflow-hidden rounded-full bg-secondary"
        style={{ marginInline: THUMB / 2 }}
      >
        {cap != null && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full",
              cap > full ? "bg-warning" : "bg-primary",
            )}
            style={{ width: pct(cap) }}
          />
        )}
        {used != null && used > 0 && (
          <div
            className={cn(
              "absolute inset-y-0 left-0 rounded-full transition-[width]",
              overCap ? "bg-warning" : "bg-muted-foreground",
            )}
            style={{ width: pct(used) }}
          />
        )}
      </div>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={valueText}
        min={0}
        max={full}
        step={step}
        value={Math.min(full, cap ?? 0)}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(
          "absolute inset-0 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed",
          "[&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent",
          "[&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm",
          "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-sm",
          "[&:focus-visible::-moz-range-thumb]:ring-2 [&:focus-visible::-moz-range-thumb]:ring-ring [&:focus-visible::-webkit-slider-thumb]:ring-2 [&:focus-visible::-webkit-slider-thumb]:ring-ring",
        )}
      />
    </div>
  );
}
