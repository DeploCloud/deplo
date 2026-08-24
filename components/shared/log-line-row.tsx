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
 *    This holds even when the chip is HIDDEN (`chip="auto"`): the gutter stays,
 *    or the x of the message would move from line to line as levels change.
 *
 * The 2px rail is the exception that proves the first rule — it is positioned
 * absolutely and DOES span the whole row on purpose, so a wrapped stack trace
 * reads as one block. A bar may do that; a label may not.
 */

/** Width of the level chip's gutter. Sized for the longest label (SUCCESS) with
 *  room to breathe, so no label is ever clipped and every message starts at the
 *  same x. Reserved whether or not a chip is drawn in it. */
const CHIP_WIDTH = "w-16";
const CHIP = `h-[18px] ${CHIP_WIDTH}`;

/**
 * Matches http(s) URLs inside a log line. Kept deliberately conservative: a URL
 * runs until the first whitespace, and a trailing `.,;:!?)]}` (common sentence /
 * bracket punctuation) is trimmed off the match so "see https://x.dev/foo." links
 * `https://x.dev/foo`, not `…/foo.`. The capturing group lets `split` keep the
 * URLs interleaved with the surrounding text.
 */
const URL_RE = /(https?:\/\/[^\s]+?)(?=[.,;:!?)\]}]*(?:\s|$))/g;

/**
 * Wrap every case-insensitive occurrence of `term` in a `<mark>`, returning
 * React nodes.
 *
 * Nodes, not HTML, is the whole design. Dokploy renders its ANSI to an HTML
 * string and then runs a regex `replace` over it to highlight the search term,
 * which happily rewrites the inside of a `<span class=…>` when the user searches
 * for "span" or "class". Here the ANSI parse, the linkifier and the highlighter
 * each hand the next one plain text and get elements back, so the three compose
 * with no escaping and no `dangerouslySetInnerHTML` anywhere.
 *
 * `indexOf` rather than a regex: the term is arbitrary user input, and scanning
 * for a literal needs no escaping and cannot backtrack.
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
        "text-[10px] leading-none font-semibold tracking-wide uppercase",
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
  chip = "always",
  highlight,
}: {
  level: LogLevel;
  text: string;
  /** Rendered as a dim, tabular gutter. Omitted by streams that carry no clock. */
  time?: string;
  /**
   * Colour the message to match its level. True where the level is AUTHORED by
   * the producer (build + deployment logs). Runtime container logs pass false:
   * their level is inferred from the text, and tinting a whole pane on an
   * inference turns a stray "error" inside a JSON payload into a red line.
   * The chip still shows it; the message stays neutral.
   */
  tintMessage?: boolean;
  /**
   * `"auto"` draws the chip only when there is something to say — i.e. not for
   * `info`. Runtime logs use it: once the level detector stops guessing, most
   * lines ARE info, and a column of identical grey INFO chips down a full-screen
   * pane is noise that hides the four chips that matter. Build logs keep
   * `"always"`, where the level is authored and every line carries real meaning.
   */
  chip?: "always" | "auto";
  /** Search term to mark inside the message. Composes with ANSI and links. */
  highlight?: string;
}) {
  const showChip = chip === "always" || level !== "info";

  return (
    <div
      className={cn(
        // items-start, not the default stretch — see LevelChip.
        "group relative flex items-start gap-3 rounded-md py-px pr-1.5 pl-3 log-row",
        "transition-colors",
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
        <span className="shrink-0 self-start pt-px text-[11px] text-zinc-600 tabular-nums select-none">
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
        {/*
          Log producers (docker build, buildkit, app stdout) emit raw ANSI, and
          lines are stored verbatim — so parse each line into styled runs: SGR
          colors render as colors, every other escape is swallowed instead of
          showing up as `[0m`-style garbage. Parsing is per line, so styling
          deliberately does NOT carry across rows: a producer that forgets its
          reset tints one line, not the whole rest of the log. A segment's own
          color (a nested class) wins over the level tint inherited from this
          span; unstyled segments keep the tint.
        */}
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
