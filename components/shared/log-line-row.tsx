import { cn } from "@/lib/utils";
import { parseAnsi } from "@/lib/ansi";
import {
  LEVEL_BADGE_CLASS,
  LEVEL_BAR_CLASS,
  LEVEL_LABEL,
  LEVEL_ROW_CLASS,
  LEVEL_TEXT_CLASS,
} from "@/lib/log-levels";
import type { LogLevel } from "@/lib/types/deployment";

const CHIP_WIDTH = "w-[calc(var(--log-fs)*4.92)]";
const CHIP = `h-[calc(var(--log-fs)*1.38)] ${CHIP_WIDTH}`;

const URL_RE = /(https?:\/\/[^\s]+?)(?=[.,;:!?)\]}]*(?:\s|$))/g;

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
  time?: string;
  tintMessage?: boolean;
  chip?: "always" | "auto";
  zebra?: boolean;
  highlight?: string;
}) {
  const showChip = chip === "always" || level !== "info";

  return (
    <div
      className={cn(
        "group relative flex items-start gap-3 rounded-md py-px pr-1.5 pl-3 log-row",
        "transition-colors",
        zebra && "bg-terminal-stripe",
        LEVEL_ROW_CLASS[level] ?? "hover:bg-surface",
      )}
    >
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

export function LogLinesSkeleton() {
  return (
    <div aria-hidden className="space-y-0.5">
      {SKELETON_WIDTHS.map((width, i) => (
        <div
          key={i}
          className="flex animate-pulse items-start gap-3 py-px pr-1.5 pl-3"
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
