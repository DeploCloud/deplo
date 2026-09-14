"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// CommitLink - the short commit SHA, linked to GitHub when the source is a repo.
export function CommitLink({
  sha,
  url,
  className,
  length = 7,
}: {
  sha: string;
  url: string | null;
  className?: string;
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
