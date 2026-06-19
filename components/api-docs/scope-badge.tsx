"use client";

import { ShieldCheck, Lock, Globe, KeyRound } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CAPABILITY_META } from "@/lib/membership-shared";
import { cn } from "@/lib/utils";
import type { FieldScope } from "./types";

/** Short human label for a field's required scope. */
export function scopeLabel(scope: FieldScope): string {
  switch (scope.kind) {
    case "public":
      return "Public";
    case "loggedIn":
      return "Authenticated";
    case "instanceAdmin":
      return "Instance admin";
    case "capability":
      return CAPABILITY_META[scope.capability]?.label ?? scope.capability;
  }
}

/**
 * A badge summarising what a field requires. `held` (when provided) tints the
 * badge: green when the current viewer satisfies the scope, muted when not —
 * so the docs double as a personalised "what can I call" map.
 */
export function ScopeBadge({
  scope,
  held,
  className,
}: {
  scope: FieldScope;
  held?: boolean;
  className?: string;
}) {
  const Icon =
    scope.kind === "public"
      ? Globe
      : scope.kind === "instanceAdmin"
        ? ShieldCheck
        : scope.kind === "capability"
          ? KeyRound
          : Lock;

  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-normal",
        held === true && "border-[var(--success)]/40 text-[var(--success)]",
        held === false && "text-muted-foreground",
        className,
      )}
      title={
        scope.kind === "capability"
          ? CAPABILITY_META[scope.capability]?.description
          : undefined
      }
    >
      <Icon className="size-3" />
      {scopeLabel(scope)}
    </Badge>
  );
}
