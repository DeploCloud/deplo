// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi";
import {
  LEVEL_BADGE_CLASS,
  LEVEL_BAR_CLASS,
  LEVEL_LABEL,
  LEVEL_ROW_CLASS,
  LEVEL_TEXT_CLASS,
} from "@/lib/log-levels";
import type { LogLevel } from "@/lib/types";

/**
 * The one row shape every log console renders: the build-log stream, the
 * deployments Logs page, and the app's live runtime logs.
 */

/** Width of the level chip's gutter. Sized for the longest label (SUCCESS) with
 *  room to breathe, so no label is ever clipped and every message starts at the
 *  same x. Reserved whether or not a chip is drawn in it. */
const CHIP_WIDTH = "w-[calc(var(--log-fs)*4.92)]";
const CHIP = `h-[calc(var(--log-fs)*1.38)] ${CHIP_WIDTH}`;

/**
 * Matches http(s) URLs inside a log line.
 */
const URL_RE = /(https?:\/\/[^\s]+?)(?=[.,;:!?)\]}]*(?:\s|$))/g;

/**
 * Wrap every case-insensitive occurrence of `term` in a `<mark>`, returning React
 * nodes. `indexOf` rather than a regex: the term is arbitrary user input, and
 * scanning for a literal needs no escaping and cannot backtrack.
 */
function markMatches(text: string, term: string): React.ReactNode {
  if (!term) return text;
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();

  const out: React.ReactNode[] = [];
  let at = 0;
  for (;;) {
    const hit = hay.indexOf(needle, at);
    if (hit === -1) break;
    if (hit > at) out.push(text.slice(at, hit));
    out.push(
      <mark key={hit} className="rounded-[2px] bg-yellow-400/30 text-inherit">
        {text.slice(hit, hit + needle.length)}
      </mark>,
    );
    at = hit + needle.length;
  }
  if (out.length === 0) return text;
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/**
 * Render a log message with any http(s) URLs turned into links that open in a new
 * tab (underlined). Everything between URLs stays plain text, so `whitespace-pre-wrap`
 * on the parent still governs wrapping and indentation.
 */
function LinkifiedText({
  text,
  highlight = "",
}: {
  text: string;
  highlight?: string;
}) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        // Odd indices are the captured URLs (see URL_RE); even are plain text.
        i % 2 === 1 ? (
          <a
            key={i}
            href={part}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {markMatches(part, highlight)}
          </a>
        ) : (
          <span key={i}>{markMatches(part, highlight)}</span>
        ),
      )}
    </>
  );
}

export function LevelChip({
  level,
  className,
}: {
  level: LogLevel;
  className?: string;
}) {
  return (
    <span
      className={cn(
        CHIP,
        // `self-start` + a fixed height is the whole fix: the chip never grows
        // with the line it labels. `leading-none` keeps the text centred in the
        // box rather than riding the row's line-height.
        "inline-flex shrink-0 items-center justify-center self-start rounded select-none",
        "text-[length:calc(var(--log-fs)*0.77)] leading-none font-semibold tracking-wide uppercase",
        LEVEL_BADGE_CLASS[level] ?? "bg-zinc-700/30 text-zinc-300",
        className,
      )}
    >
      {LEVEL_LABEL[level] ?? level}
    </span>
  );
}

/**
 * The scrolling body of a log console. Owns the vertical rhythm - a small,
 * consistent gap between lines so a dense stream reads as lines rather than as a
 * wall, and the monospace type.
 */
export function LogLines({
  children,
  className,
  ...rest
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "space-y-0.5 overflow-y-auto bg-terminal p-3 font-mono text-[length:var(--log-fs)] leading-[var(--log-lh)]",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function LogRow({
  level,
  text,
  time,
  tintMessage = true,
  chip = "always",
  zebra = false,
  highlight,
}: {
  level: LogLevel;
  text: string;
  /** Rendered as a dim, tabular gutter. Omitted by streams that carry no clock. */
  time?: string;
  /**
   * Colour the message to match its level.
   */
  tintMessage?: boolean;
  /**
   * `"auto"` draws the chip only when there is something to say - i.e. not for
   * `info`.
   */
  chip?: "always" | "auto";
  /**
   * Draw this row on the banded background instead of the bare slab - the caller
   * alternates it, so a live stream reads as lines rather than as one black field.
   */
  zebra?: boolean;
  /** Search term to mark inside the message. Composes with ANSI and links. */
  highlight?: string;
}) {
  const showChip = chip === "always" || level !== "info";

  return (
    <div
      className={cn(
        // items-start, not the default stretch - see LevelChip.
        "group relative flex items-start gap-3 rounded-md py-px pr-1.5 pl-3 log-row",
        "transition-colors",
        // Before the level, never after: `cn` keeps the LAST background, so a
        // warn or error row wins its wash back and only the neutral lines band.
        zebra && "bg-terminal-stripe",
        // The level's own faint wash, hover included. `info` supplies only the
        // neutral hover, so an ordinary line stays an ordinary line.
        LEVEL_ROW_CLASS[level] ?? "hover:bg-white/[0.04]",
      )}
    >
      {/* The rail. Absolute so it costs no horizontal space and spans the full
          row height, wrapped lines included. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0.5 w-0.5 rounded-full",
          LEVEL_BAR_CLASS[level] ?? "bg-transparent",
        )}
      />

      {time !== undefined && (
        <span className="shrink-0 self-start pt-px text-[length:calc(var(--log-fs)*0.85)] text-zinc-600 tabular-nums select-none">
          {time}
        </span>
      )}

      {showChip ? (
        <LevelChip level={level} />
      ) : (
        // The gutter is reserved even with no chip in it, so the message column
        // does not shift left and right as levels change from line to line.
        <span aria-hidden className={cn(CHIP_WIDTH, "shrink-0")} />
      )}

      <span
        className={cn(
          "min-w-0 flex-1 break-words whitespace-pre-wrap",
          tintMessage
            ? (LEVEL_TEXT_CLASS[level] ?? "text-zinc-300")
            : "text-zinc-300",
        )}
      >
        {parseAnsi(text).map((seg, i) =>
          seg.className ? (
            <span key={i} className={seg.className}>
              <LinkifiedText text={seg.text} highlight={highlight} />
            </span>
          ) : (
            <LinkifiedText key={i} text={seg.text} highlight={highlight} />
          ),
        )}
      </span>
    </div>
  );
}

/** Message-bar widths for the placeholder rows, so the block reads as log lines
 *  of differing length rather than as a solid slab. */
const SKELETON_WIDTHS = [
  "w-[38%]",
  "w-[62%]",
  "w-[27%]",
  "w-[55%]",
  "w-[44%]",
  "w-[70%]",
  "w-[33%]",
  "w-[50%]",
];

/**
 * Placeholder lines for a console that has no rows yet but is still waiting on
 * data (a build that has been claimed but hasn't printed anything).
 */
export function LogLinesSkeleton() {
  return (
    <div aria-hidden className="space-y-0.5">
      {SKELETON_WIDTHS.map((width, i) => (
        <div
          key={i}
          className="flex animate-pulse items-start gap-3 py-px pr-1.5 pl-3"
          // Staggered so the rows breathe one after another, the way lines
          // actually arrive, instead of blinking in unison.
          style={{ animationDelay: `${i * 120}ms` }}
        >
          <span className="h-[var(--log-fs)] w-[calc(var(--log-fs)*4)] shrink-0 rounded bg-zinc-800" />
          <span className={cn(CHIP, "shrink-0 rounded bg-zinc-800")} />
          <span
            className={cn("h-[var(--log-fs)] rounded bg-zinc-800", width)}
          />
        </div>
      ))}
    </div>
  );
}
