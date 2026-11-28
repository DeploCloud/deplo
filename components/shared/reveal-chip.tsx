"use client";

import * as React from "react";
import { Check, Copy, Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export const REVEAL_MASK = "••••••••••••";

const OUTER =
  "relative block h-7 w-full rounded-full align-middle ring-1 ring-inset";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";
const TOGGLE =
  "group cursor-pointer text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

export const COPIED_FOR_MS = 1500;

export function RevealChip({
  value = null,
  revealed = false,
  onToggle,
  onCopy,
  copyLabel = "Copy",
  placeholder = REVEAL_MASK,
  placeholderClassName,
  pending = false,
  locked = false,
  lockedHint = "Secret - hidden, and can never be read back.",
  readOnly = false,
  labels = { reveal: "Reveal value", hide: "Hide value" },
  className,
}: {
  value?: string | null;
  revealed?: boolean;
  onToggle?: () => void;
  // Returns what to copy; null copies nothing (a failed reveal already said why).
  onCopy?: () => string | null | Promise<string | null>;
  copyLabel?: string;
  placeholder?: string;
  placeholderClassName?: string;
  pending?: boolean;
  locked?: boolean;
  lockedHint?: string;
  readOnly?: boolean;
  labels?: { reveal: string; hide: string };
  className?: string;
}) {
  function handleClick() {
    if (revealed && (window.getSelection()?.toString().length ?? 0) > 0) return;
    onToggle?.();
  }

  if (locked || readOnly) {
    return (
      <span
        title={locked ? lockedHint : placeholder}
        className={cn(OUTER, "bg-surface ring-border/50", className)}
      >
        <span className={INNER}>
          <code
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground",
              placeholderClassName,
            )}
          >
            {placeholder}
          </code>
          {locked && (
            <Lock
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden
            />
          )}
        </span>
        {locked && <span className="sr-only">Secret value, hidden</span>}
      </span>
    );
  }

  const face = (
    <span className={INNER}>
      {pending ? (
        <Loader2
          aria-hidden
          className="size-3.5 shrink-0 animate-spin text-muted-foreground/60"
        />
      ) : revealed ? (
        <EyeOff
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
        />
      ) : (
        <Eye
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
        />
      )}
      {revealed && value !== null ? (
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90 select-text">
          {value}
        </code>
      ) : (
        <code
          aria-hidden
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-none",
            placeholderClassName,
          )}
        >
          {placeholder}
        </code>
      )}
    </span>
  );
  const toggleProps = {
    type: "button" as const,
    onClick: handleClick,
    disabled: pending,
    "aria-pressed": revealed,
    "aria-label": revealed ? labels.hide : labels.reveal,
    title: revealed && value !== null ? value : "Click to reveal",
  };
  const tone = revealed ? "ring-border/40" : "bg-surface ring-border/50";

  if (!onCopy) {
    return (
      <button
        {...toggleProps}
        className={cn(
          OUTER,
          TOGGLE,
          tone,
          "hover:bg-surface",
          pending && "cursor-progress",
          className,
        )}
      >
        {face}
      </button>
    );
  }

  // Two controls side by side: a button inside a button is not valid HTML.
  return (
    <span className={cn(OUTER, "flex items-center", tone, className)}>
      <button
        {...toggleProps}
        className={cn(
          "relative h-full min-w-0 flex-1 rounded-l-full hover:bg-surface",
          TOGGLE,
          pending && "cursor-progress",
        )}
      >
        {face}
      </button>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
      <CopySlot onCopy={onCopy} label={copyLabel} />
    </span>
  );
}

type CopyPhase = "idle" | "copied" | "back";

// Copy leaves upwards as the check arrives from below, and back again after a beat.
function CopySlot({
  onCopy,
  label,
}: {
  onCopy: () => string | null | Promise<string | null>;
  label: string;
}) {
  const [phase, setPhase] = React.useState<CopyPhase>("idle");
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    setBusy(true);
    const v = await onCopy();
    setBusy(false);
    if (v === null || !(await copyText(v))) return;
    setPhase("copied");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPhase("back"), COPIED_FOR_MS);
  }

  const copyIcon = <Copy className="absolute inset-0 size-3.5" />;
  const checkIcon = (
    <Check className="absolute inset-0 size-3.5 text-[var(--success)]" />
  );
  const [leaving, arriving] =
    phase === "copied" ? [copyIcon, checkIcon] : [checkIcon, copyIcon];

  return (
    <button
      type="button"
      onClick={copy}
      disabled={busy}
      aria-label={label}
      className="flex h-full shrink-0 cursor-pointer items-center rounded-r-full px-2 text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-progress"
    >
      <span
        key={phase}
        aria-hidden
        className="relative size-3.5 overflow-hidden"
      >
        {busy ? (
          <Loader2 className="absolute inset-0 size-3.5 animate-spin" />
        ) : phase === "idle" ? (
          copyIcon
        ) : (
          <>
            <span className="animate-step-out-up absolute inset-0">
              {leaving}
            </span>
            <span className="animate-step-in-up absolute inset-0">
              {arriving}
            </span>
          </>
        )}
      </span>
      <span className="sr-only" aria-live="polite">
        {phase === "copied" ? "Copied" : ""}
      </span>
    </button>
  );
}
