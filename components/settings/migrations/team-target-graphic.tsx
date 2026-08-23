import { cn } from "@/lib/utils";

/**
 * The mark beside "everything lands in <team>": an open crate with three things
 * already in it.
 *
 * Static on purpose. Every other graphic here animates because it is telling you
 * what is happening; this one sits next to a sentence that already says where
 * things go, so movement would only compete with the wizard's own illustration
 * two hand-spans to the right.
 *
 * `aria-hidden` for the same reason - the title beside it is the label.
 */
export function TeamTargetGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden
      className={cn("size-10 shrink-0", className)}
    >
      {/* The open flaps, so it reads as a crate being filled and not a box. */}
      <path
        d="M9 21 L3 15"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M39 21 L45 15"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <rect
        x="8"
        y="20"
        width="32"
        height="21"
        rx="3.5"
        className="stroke-ring"
        strokeWidth="2.5"
      />
      {/* Three, because two reads as a pair and four as a crowd. */}
      <rect x="13" y="26" width="6" height="9" rx="1.5" className="fill-primary" />
      <rect x="21" y="26" width="6" height="9" rx="1.5" className="fill-muted-foreground" />
      <rect x="29" y="26" width="6" height="9" rx="1.5" className="fill-ring" />
    </svg>
  );
}
