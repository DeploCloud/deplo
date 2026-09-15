"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DownloadButton({
  value,
  filename,
  className,
  size = "icon-sm",
  label,
}: {
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
