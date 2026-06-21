import type { LogLevel } from "./types";

/**
 * Presentation for a deployment log line's severity. The producer side already
 * tags every line with a {@link LogLevel} (build.ts/builders/agent); this is the
 * single place the UI turns that tag into a visible label + colors, so the
 * build-log stream and the logs page render identical pills and the copied text
 * carries the same label. Keep this in sync with `LogLevel` — the `Record`
 * types force every level to be covered.
 */

/** Short uppercase label shown in the per-line pill and the copied log text. */
export const LEVEL_LABEL: Record<LogLevel, string> = {
  command: "CMD",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
  debug: "DEBUG",
  success: "SUCCESS",
};

/** Tailwind classes for the per-line pill (tinted background + matching text). */
export const LEVEL_BADGE_CLASS: Record<LogLevel, string> = {
  command: "bg-zinc-700/40 text-zinc-100",
  info: "bg-zinc-700/30 text-zinc-300",
  warn: "bg-warning/15 text-warning",
  error: "bg-destructive/15 text-destructive",
  debug: "bg-zinc-800/60 text-muted-foreground",
  success: "bg-success/15 text-success",
};

/** Classes for the log MESSAGE text itself (the pill carries the level color). */
export const LEVEL_TEXT_CLASS: Record<LogLevel, string> = {
  command: "font-semibold text-white",
  info: "text-zinc-300",
  warn: "text-[var(--warning)]",
  error: "text-destructive",
  debug: "text-muted-foreground",
  success: "text-[var(--success)]",
};

/** Width to pad every label to so copied lines align in a column. */
const LABEL_WIDTH = Math.max(...Object.values(LEVEL_LABEL).map((l) => l.length));

/** A copy-friendly, fixed-width label prefix, e.g. `SUCCESS ` / `INFO    `. */
export function levelLabelPadded(level: LogLevel): string {
  return (LEVEL_LABEL[level] ?? level.toUpperCase()).padEnd(LABEL_WIDTH);
}
