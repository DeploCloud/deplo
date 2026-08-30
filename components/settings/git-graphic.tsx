import { cn } from "@/lib/utils";

/** The Git empty-state illustration: a repository being cloned across. */
export function GitGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A repository being copied from a git host into a list of repositories"
      className={cn("size-32", className)}
    >
      <line
        x1="50"
        y1="45"
        x2="70"
        y2="45"
        className="stroke-border"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
      />

      <rect
        x="4"
        y="14"
        width="44"
        height="62"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-ring" strokeLinecap="round">
        {[29, 45, 61].map((y) => (
          <g key={y}>
            <circle cx="15" cy={y} r="3" />
            <line
              x1="22"
              y1={y}
              x2="40"
              y2={y}
              className="stroke-ring"
              strokeWidth="5"
            />
          </g>
        ))}
      </g>

      <rect
        x="72"
        y="14"
        width="44"
        height="62"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />

      <g strokeLinecap="round">
        {[29, 45, 61].map((y) => (
          <g key={y} className="deplo-git-row">
            <circle cx="83" cy={y} r="3" fill="var(--violet)" />
            <line
              x1="90"
              y1={y}
              x2="108"
              y2={y}
              stroke="var(--violet)"
              strokeWidth="5"
            />
          </g>
        ))}
      </g>

      <g className="deplo-git-copy">
        <rect
          x="8"
          y="35"
          width="36"
          height="20"
          rx="6"
          className="fill-card"
          stroke="var(--violet)"
          strokeWidth="2.5"
        />
        <circle cx="17" cy="45" r="2.5" fill="var(--violet)" />
        <line
          x1="24"
          y1="45"
          x2="40"
          y2="45"
          stroke="var(--violet)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
