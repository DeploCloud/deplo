"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

// Select, chevron, key, value, last modified, modified by, actions. Below md a row stacks.
export const ENV_LIST_COLS =
  "md:grid md:grid-cols-[1rem_1rem_minmax(0,1.1fr)_minmax(0,1.4fr)_7.5rem_9rem_5.5rem] md:items-center md:gap-3";

export function EnvList({
  select,
  children,
}: {
  select: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      <div
        className={cn(
          ENV_LIST_COLS,
          "h-10 px-3 text-xs font-medium text-muted-foreground max-md:hidden",
        )}
      >
        {select}
        <span />
        <span>Key</span>
        <span className="max-md:hidden">Value</span>
        <span>Last modified</span>
        <span>Modified by</span>
        <span className="text-right">Actions</span>
      </div>
      {children}
    </div>
  );
}

export type EnvRowTone = "pending" | "draft";

export function EnvListRow({
  select,
  open,
  onToggle,
  keyCell,
  value,
  modified,
  author,
  actions,
  panel,
  tone,
}: {
  select?: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  keyCell: React.ReactNode;
  value: React.ReactNode;
  modified?: React.ReactNode;
  author?: React.ReactNode;
  actions: React.ReactNode;
  panel: React.ReactNode;
  tone?: EnvRowTone;
}) {
  return (
    <div
      className={cn(
        open && "bg-surface",
        tone === "pending" && "shadow-[inset_2px_0_0_var(--warning)]",
        tone === "draft" && "shadow-[inset_2px_0_0_var(--info)]",
      )}
    >
      <div className={cn(ENV_LIST_COLS, "flex items-start gap-2 px-3 py-2.5")}>
        <div className="flex h-5 items-center max-md:hidden">{select}</div>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={open ? "Hide details" : "Show details"}
          className="flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
        </button>
        <div className="min-w-0 flex-1 font-mono text-xs font-medium max-md:break-all">
          {keyCell}
        </div>
        <div className="min-w-0 max-md:hidden">{value}</div>
        <div className="text-xs whitespace-nowrap text-muted-foreground max-md:hidden">
          {modified}
        </div>
        <div className="min-w-0 max-md:hidden">{author}</div>
        <div className="flex shrink-0 justify-end">{actions}</div>
      </div>
      {open && <div className="px-3 pb-4 pl-9 md:pl-[4.25rem]">{panel}</div>}
    </div>
  );
}

// A note keeps its own line breaks; a row without one says so instead of opening onto nothing.
export function EnvNotePanel({
  note,
  action,
}: {
  note: string | null | undefined;
  action?: React.ReactNode;
}) {
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-xs font-medium">Note</p>
      {note ? (
        <p className="text-sm leading-relaxed whitespace-pre-line text-muted-foreground">
          {note}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">No note yet.</p>
      )}
      {action}
    </div>
  );
}
