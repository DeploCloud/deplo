"use client";

import * as React from "react";
import { ChevronRight, Box } from "lucide-react";
import { TeamAvatar } from "@/components/shared/user-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { LogoImage } from "@/components/shared/project-logo";
import { cn } from "@/lib/utils";

export function TeamMark({
  name,
  avatarUrl,
}: {
  name: string;
  avatarUrl?: string | null;
}) {
  return <TeamAvatar name={name} avatarUrl={avatarUrl} size="xs" />;
}

export function AppMark({ logo }: { logo: string | null }) {
  return (
    <LogoImage
      src={logo}
      size={16}
      fallback={<Box className="size-3" />}
      className="rounded-sm bg-transparent"
    />
  );
}

export function Row({
  depth,
  mark,
  label,
  meta,
  checkbox = true,
  checked,
  disabled,
  onCheckedChange,
  expandable = false,
  expanded = false,
  onToggleExpand,
  id,
  right,
}: {
  depth: number;
  mark: React.ReactNode;
  label: string;
  meta?: string;
  checkbox?: boolean;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (on: boolean) => void;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  id: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 py-2 pr-3",
        depth === 0 && "bg-surface",
      )}
      style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={expanded}
          className="rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            className={cn(
              "size-4 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
      ) : (
        <span className="size-4" aria-hidden />
      )}
      {checkbox ? (
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          onCheckedChange={(v) => onCheckedChange(v === true)}
        />
      ) : (
        <span className="size-4" aria-hidden />
      )}
      <label
        htmlFor={id}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2",
          checkbox && !disabled && "cursor-pointer",
        )}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {mark}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm",
            depth === 0 && "font-medium",
          )}
        >
          {label}
        </span>
        {meta && (
          <span className="shrink-0 truncate text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </label>
      {right && <div className="flex shrink-0 items-center">{right}</div>}
    </div>
  );
}
