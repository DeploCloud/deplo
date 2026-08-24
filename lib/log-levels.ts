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

/**
 * The 2px rail down the left edge of a row. Unlike the chip, this one SPANS the
 * whole row, wrapped lines included: that is the point of it. A stack trace is
 * one event printed across a dozen lines, and an unbroken rail beside all of
 * them is what makes it read as a single block instead of a dozen records.
 *
 * `info` is deliberately blank. Most lines are info once the level detector
 * stops guessing, and a rail beside every one of them is a rail beside none.
 */
export const LEVEL_BAR_CLASS: Record<LogLevel, string> = {
  command: "bg-zinc-600",
  info: "bg-transparent",
  warn: "bg-[var(--warning)]",
  error: "bg-destructive",
  debug: "bg-zinc-700",
  success: "bg-success",
};

/**
 * A faint wash of the level's own colour across the whole row, and a slightly
 * stronger one on hover. Same idea as the notice chip in the toolbar: the colour
 * says what kind of thing this is before you have read a word of it.
 *
 * `info` gets NO wash, only the neutral hover. It is the majority of any log
 * once the detector stops guessing, and a tint behind every line is a tint
 * behind none — the whole point is that the four rows that matter stand out of
 * the page. Kept at single digits: a screenful of errors should read as a page
 * with red in it, not as a red page.
 */
export const LEVEL_ROW_CLASS: Record<LogLevel, string> = {
  command: "bg-zinc-400/[0.05] hover:bg-zinc-400/[0.09]",
  info: "hover:bg-white/[0.04]",
  warn: "bg-[var(--warning)]/[0.08] hover:bg-[var(--warning)]/[0.14]",
  error: "bg-destructive/[0.08] hover:bg-destructive/[0.14]",
  debug: "bg-zinc-400/[0.05] hover:bg-zinc-400/[0.09]",
  success: "bg-success/[0.07] hover:bg-success/[0.13]",
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

/**
 * How a level reads in the FILTER MENU, as a word rather than a shout.
 *
 * Separate from {@link LEVEL_LABEL} on purpose. That one is a fixed-width tag
 * stamped on a line of monospace output and pasted into a bug report, where
 * `ERROR` is the convention and the alignment is the point. This one is an
 * option in a dropdown, sitting next to `All levels` and `Search` — sentence
 * case, like every other menu in the product. `Warning` rather than `Warn`
 * because the menu has the room and that is the word people know.
 */
export const LEVEL_MENU_LABEL: Record<LogLevel, string> = {
  command: "Command",
  info: "Info",
  warn: "Warning",
  error: "Error",
  debug: "Debug",
  success: "Success",
};

/**
 * The level's own colour, for that menu.
 *
 * Token utilities, not the console's {@link LEVEL_TEXT_CLASS}: those are tuned
 * for light text on the log pane's permanent dark background (`text-white`,
 * `text-zinc-300`) and would be invisible in a dropdown, which follows the
 * theme. `command` and `info` stay `text-foreground` for the same reason `info`
 * gets no rail and no row wash — they are the majority of any log, and colouring
 * everything colours nothing.
 */
export const LEVEL_MENU_CLASS: Record<LogLevel, string> = {
  command: "text-foreground",
  info: "text-foreground",
  warn: "text-warning",
  error: "text-destructive",
  debug: "text-muted-foreground",
  success: "text-success",
};

/** Width to pad every label to so copied lines align in a column. */
const LABEL_WIDTH = Math.max(...Object.values(LEVEL_LABEL).map((l) => l.length));

/** A copy-friendly, fixed-width label prefix, e.g. `SUCCESS ` / `INFO    `. */
export function levelLabelPadded(level: LogLevel): string {
  return (LEVEL_LABEL[level] ?? level.toUpperCase()).padEnd(LABEL_WIDTH);
}
