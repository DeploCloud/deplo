"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Save a block of text to a file via a throwaway object URL. Mirrors
 * {@link CopyButton}: icon-only by default, or a labeled outline button when
 * `label` is set — so the log toolbars can sit a download button beside copy.
 */
export function DownloadButton({
  value,
  filename,
  className,
  size = "icon-sm",
  label,
}: {
  value: string;
  filename: string;
  className?: string;
  size?: "icon" | "icon-sm" | "sm";
  label?: string;
}) {
  function download() {
    const blob = new Blob([value], { type: "text/plain;charset=utf-8" });
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
