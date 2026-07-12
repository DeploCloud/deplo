"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The short commit SHA. When the service deploys from a GitHub source we know the
 * repo, so it links to that exact commit on GitHub (opened in a new tab);
 * otherwise (non-GitHub source, or no commit) it renders as plain monospace text.
 *
 * Rendered as a role="link" <code> rather than an <a> so it stays valid,
 * keyboard-navigable HTML even when it sits inside a row-level <Link> (the
 * deployment lists) — an <a> nested in an <a> is invalid. On activation it stops
 * propagation so clicking the SHA never ALSO fires that row's navigation, then
 * opens the commit URL in a new tab.
 */
export function CommitLink({
  sha,
  url,
  className,
  length = 7,
}: {
  sha: string;
  /** The GitHub commit URL, or null when the source isn't a GitHub repo. */
  url: string | null;
  className?: string;
  /** How many leading SHA chars to show (matches the long-standing 7). */
  length?: number;
}) {
  const short = (sha ?? "").slice(0, length);
  if (!url || !short) {
    return <code className={className}>{short}</code>;
  }

  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <code
      role="link"
      tabIndex={0}
      title={`View commit ${short} on GitHub`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") open(e);
      }}
      className={cn(
        "cursor-pointer underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground",
        className,
      )}
    >
      {short}
    </code>
  );
}
