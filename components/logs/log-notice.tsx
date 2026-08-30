"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { CircleAlert } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Context the log pane must not be read without - a crash loop whose banner is
 * missing reads as an app printing a stack trace on a timer. A toolbar chip, not
 * a strip: in a crash loop a strip never goes away.
 */
export interface LogNotice {
  tone: "error" | "warn" | "muted";
  icon: typeof CircleAlert;
  /** Spinner, pulse - whatever the banner used to animate. Optional. */
  iconClass?: string;
  /** The chip's own words. Short: it sits in a toolbar. */
  short: string;
  title: string;
  body: string;
}

const TONE: Record<LogNotice["tone"], string> = {
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  warn: "border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]",
  muted: "border-border bg-secondary/60 text-muted-foreground",
};

export function LogNoticeChip({
  notice,
  className,
}: {
  notice: LogNotice | null;
  className?: string;
}) {
  if (!notice) return null;
  const Icon = notice.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={notice.title}
          className={cn(
            "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:brightness-110",
            "focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background focus:outline-none",
            TONE[notice.tone],
            className,
          )}
        >
          <Icon className={cn("size-3.5 shrink-0", notice.iconClass)} />
          <span className="max-w-45 truncate">{notice.short}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-1 text-sm">
        <p className="font-medium">{notice.title}</p>
        <p className="text-muted-foreground">{notice.body}</p>
      </PopoverContent>
    </Popover>
  );
}
