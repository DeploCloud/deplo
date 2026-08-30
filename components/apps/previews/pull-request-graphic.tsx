// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";

/** The Pull requests empty-state illustration, in two moods. */
export function PullRequestGraphic({
  variant = "active",
  className,
}: {
  variant?: "active" | "off";
  className?: string;
}) {
  const off = variant === "off";
  return (
    <svg
      viewBox="0 0 120 100"
      fill="none"
      role="img"
      aria-label={
        off
          ? "A branch that starts and stops before it can merge"
          : "A branch merging back into the main branch"
      }
      className={cn("size-32", className)}
    >
      <line
        x1="30"
        y1="12"
        x2="30"
        y2="88"
        className="stroke-ring"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="30" cy="12" r="3.5" className="fill-ring" />

      <path
        d="M30 28 C30 40, 80 34, 80 46 L80 62 C80 74, 30 70, 30 82"
        className={
          off
            ? "deplo-pr-branch-off stroke-muted-foreground"
            : "deplo-pr-branch stroke-primary"
        }
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {!off && (
        <>
          <circle
            cx="80"
            cy="46"
            r="4.5"
            className="deplo-pr-commit-1 fill-primary"
          />
          <circle
            cx="80"
            cy="62"
            r="4.5"
            className="deplo-pr-commit-2 fill-primary"
          />

          <circle
            cx="30"
            cy="82"
            r="5"
            className="deplo-pr-merge"
            fill="var(--success)"
          />
        </>
      )}
    </svg>
  );
}
