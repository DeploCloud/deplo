import { cn } from "@/lib/utils";
import {
  LEVEL_BADGE_CLASS,
  LEVEL_LABEL,
  LEVEL_TEXT_CLASS,
} from "@/lib/log-levels";
import type { LogLevel } from "@/lib/types";

/**
 * The one row shape every log console renders: the build-log stream, the
 * deployments Logs page, and the app's live runtime logs. They had drifted into
 * three near-copies of the same markup, which is how the level chip ended up
 * stretching in two of them and sitting still in the third.
 *
 * Two rules the chip has to obey, and neither is cosmetic:
 *
 *  - FIXED HEIGHT. A chip is a label, not a bar. As a flex child it inherited
 *    `align-items: stretch`, so a wrapped ten-line stack trace grew its ERROR
 *    chip into a ten-line coloured column down the left of the pane. It is now a
 *    fixed-size box pinned to the top of its row, whatever the message does.
 *
 *  - FIXED WIDTH. The labels differ in length (CMD vs SUCCESS), so sizing the
 *    chip to its text ragged the message column — every line started at a
 *    different x. One width for all of them puts the messages in a true column.
 */

/** Width of the level chip. Sized for the longest label (SUCCESS) with room to
 *  breathe, so no label is ever clipped and every message starts at the same x. */
const CHIP = "h-[18px] w-16";

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
        "inline-flex shrink-0 select-none items-center justify-center self-start rounded",
        "text-[10px] font-semibold uppercase leading-none tracking-wide",
        LEVEL_BADGE_CLASS[level] ?? "bg-zinc-700/30 text-zinc-300",
        className,
      )}
    >
      {LEVEL_LABEL[level] ?? level}
    </span>
  );
}

/**
 * The scrolling body of a log console. Owns the vertical rhythm — a small,
 * consistent gap between lines so a dense stream reads as lines rather than as a
 * wall — and the monospace type.
 */
export function LogLines({
  children,
  className,
  ...rest
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "space-y-0.5 overflow-y-auto bg-[#0a0a0a] p-3 font-mono text-[13px] leading-relaxed",
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
}: {
  level: LogLevel;
  text: string;
  /** Rendered as a dim, tabular gutter. Omitted by streams that carry no clock. */
  time?: string;
  /**
   * Colour the message to match its level. True where the level is AUTHORED by
   * the producer (build + deployment logs). Runtime container logs pass false:
   * their level is inferred by a heuristic from the text, and tinting a whole
   * pane on a guess turns a stray "error" inside a JSON payload into a red line.
   * The chip still shows the guess; the message stays neutral.
   */
  tintMessage?: boolean;
}) {
  return (
    <div
      className={cn(
        // items-start, not the default stretch — see LevelChip.
        "group flex items-start gap-3 rounded-md px-1.5 py-px",
        "transition-colors hover:bg-white/[0.04]",
      )}
    >
      {time !== undefined && (
        <span className="shrink-0 select-none self-start pt-px text-[11px] tabular-nums text-zinc-600">
          {time}
        </span>
      )}
      <LevelChip level={level} />
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap break-words",
          tintMessage ? LEVEL_TEXT_CLASS[level] ?? "text-zinc-300" : "text-zinc-300",
        )}
      >
        {text}
      </span>
    </div>
  );
}
