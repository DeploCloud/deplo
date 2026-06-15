import { cn } from "@/lib/utils";

/** Deplo mark  an inverted (downward) triangle. Monochrome, theme-aware. */
export function DeploMark({
  className,
  size = 20,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("text-foreground", className)}
      aria-hidden="true"
    >
      {/* Inverted triangle */}
      <path d="M2 4 L22 4 L12 21 Z" fill="currentColor" />
    </svg>
  );
}

export function DeploLogo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("flex items-center gap-2 font-semibold", className)}>
      <DeploMark size={18} />
      {showWordmark && (
        <span className="text-[15px] tracking-tight">Deplo</span>
      )}
    </span>
  );
}
