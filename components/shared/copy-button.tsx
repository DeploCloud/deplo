"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  className,
  size = "icon-sm",
  label,
}: {
  /** The text itself, or a thunk read at click time - a terminal's buffer
   *  changes on every keystroke, so a snapshot prop would always be stale. */
  value: string | (() => string);
  className?: string;
  size?: "icon" | "icon-sm" | "sm";
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    if (!(await copyText(typeof value === "function" ? value() : value)))
      return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (label) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        className={className}
      >
        {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
        {copied ? "Copied" : label}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      onClick={copy}
      className={cn("text-muted-foreground hover:text-foreground", className)}
      aria-label="Copy to clipboard"
    >
      {copied ? <Check className="text-[var(--success)]" /> : <Copy />}
    </Button>
  );
}
