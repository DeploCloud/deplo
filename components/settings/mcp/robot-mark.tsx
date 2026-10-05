import { cn } from "@/lib/utils";

export function RobotMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={cn("size-4 shrink-0", className)}
    >
      <line
        x1="12"
        y1="6"
        x2="12"
        y2="4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <circle cx="12" cy="2.6" r="1.5" fill="currentColor" />
      <rect
        x="4"
        y="6"
        width="16"
        height="12"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <circle cx="9.2" cy="12" r="1.4" fill="currentColor" />
      <circle cx="14.8" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}
