"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Save a block of text to a file via a throwaway object URL. Mirrors
 * {@link CopyButton}: icon-only by default, or a labeled outline button when
 * `label` is set, so the log toolbars can sit a download button beside copy.
 */
export function DownloadButton({
  value,
  filename,
  className,
  size = "icon-sm",
  label,
}: {
  /** The text itself, or a thunk read at click time - a terminal's buffer
   *  changes on every keystroke, so a snapshot prop would always be stale. */
  value: string | (() => string);
  filename: string;
  className?: string;
  size?: "icon" | "icon-sm" | "sm";
  label?: string;
}) {
  function download() {
    const text = typeof value === "function" ? value() : value;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the click has been dispatched so the navigation isn't cut off.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  if (label) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={download}
        className={className}
      >
        <Download />
        {label}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={download}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      aria-label="Download"
    >
      <Download />
    </Button>
  );
}
