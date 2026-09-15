import { cn } from "@/lib/utils";

export function RepoSearchGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="An empty list of repositories under a magnifying glass"
      className={cn("size-24", className)}
    >
      <rect
        x="14"
        y="20"
        width="92"
        height="64"
        rx="9"
        className="stroke-border"
        strokeWidth="2.5"
      />
      <rect
        x="27"
        y="35"
        width="30"
        height="5"
        rx="2.5"
        className="fill-ring"
      />
      {[52, 66].map((y) => (
        <line
          key={y}
          x1="27"
          y1={y}
          x2="93"
          y2={y}
          className="stroke-ring"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      ))}

      <circle
        cx="74"
        cy="70"
        r="19"
        className="stroke-muted-foreground"
        strokeWidth="3"
      />
      <line
        x1="88"
        y1="84"
        x2="99"
        y2="95"
        className="stroke-muted-foreground"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M65 63a11 11 0 0 1 7-5"
        className="stroke-background"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
