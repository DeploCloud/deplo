// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

export function CodeBlock({
  code,
  className,
  language,
  filename,
}: {
  code: string;
  className?: string;
  language?: string;
  filename?: string;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-lg border border-border bg-[#0a0a0a] dark:bg-[#0a0a0a]",
        className,
      )}
    >
      {(filename || language) && (
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <span className="font-mono text-xs text-muted-foreground">
            {filename ?? language}
          </span>
        </div>
      )}
      {/* Copy sits in the top-right; the scroll area below reserves room (pr-12)
          so a long first line never slides under it. */}
      <div className="absolute top-2 right-2 z-10">
        <CopyButton value={code} />
      </div>
      {/* Bounded box that scrolls on BOTH axes - long lines scroll sideways and a
          tall block scrolls vertically, instead of stretching/overflowing the page. */}
      <pre className="max-h-[60vh] overflow-auto p-4 pr-12 text-xs leading-relaxed">
        <code className="font-mono text-zinc-200">{code}</code>
      </pre>
    </div>
  );
}

/** Inline command with copy button - for install one-liners. */
export function CommandLine({
  command,
  truncate,
}: {
  command: string;
  /**
   * Keep it to one line, cut off at the edge.
   */
  truncate?: boolean;
}) {
  return (
    // `items-center` once truncated: the copy button is taller than one line of
    // code, so top-aligning a single line leaves a band of dead space under it.
    // A wrapped command still aligns to the top, where its first line is.
    <div
      className={cn(
        "flex gap-2 rounded-lg border border-border bg-[#0a0a0a] px-3 py-2",
        truncate ? "items-center" : "items-start",
      )}
    >
      <span className="font-mono text-sm leading-relaxed text-muted-foreground select-none">
        $
      </span>
      {/**
       * By default WRAP the command (break-all) instead of scrolling it: the whole
       * one-liner, long bootstrap token and all, stays visible and fully selectable, so
       * it copies correctly by hand too, with zero horizontal overflow.
       */}
      <code
        className={cn(
          "min-w-0 flex-1 font-mono text-sm leading-relaxed text-zinc-200",
          truncate ? "truncate" : "break-all whitespace-pre-wrap",
        )}
      >
        {command}
      </code>
      <CopyButton value={command} className="shrink-0" />
    </div>
  );
}
