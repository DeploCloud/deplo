"use client";

import * as React from "react";
import { BadgeAlert, BadgeCheck } from "lucide-react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { CommitSignature } from "@/lib/types/deployment";
import { cn } from "@/lib/utils";

export function CommitLink({
  sha,
  url,
  signature,
  className,
  length = 7,
}: {
  sha: string;
  url: string | null;
  signature?: CommitSignature | null;
  className?: string;
  length?: number;
}) {
  const short = (sha ?? "").slice(0, length);
  const badge = short && signature ? <SignatureBadge of={signature} /> : null;
  if (!url || !short) {
    return (
      <>
        <code className={className}>{short}</code>
        {badge}
      </>
    );
  }

  const open = (e: React.SyntheticEvent) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <>
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
      {badge}
    </>
  );
}

function SignatureBadge({ of }: { of: CommitSignature }) {
  const verified = of === "verified";
  const Icon = verified ? BadgeCheck : BadgeAlert;
  const label = verified ? "Verified commit" : "Unverified commit";
  return (
    <SimpleTooltip
      content={
        verified ? (
          label
        ) : (
          <>
            <p className="font-medium">{label}</p>
            <p>GitHub could not verify its signature.</p>
          </>
        )
      }
    >
      <span role="img" aria-label={label} className="inline-flex">
        <Icon
          className={cn(
            "size-3.5 shrink-0 text-background",
            verified ? "fill-info" : "fill-warning",
          )}
        />
      </span>
    </SimpleTooltip>
  );
}
