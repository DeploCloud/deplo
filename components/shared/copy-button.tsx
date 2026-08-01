"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * `navigator.clipboard` exists only in a SECURE context. A Deplo reached over
 * plain http — an IP, a LAN hostname, the first-run URL before a domain is set
 * up — has no clipboard API at all, so every copy button on the page would be a
 * silent no-op. Fall back to the legacy select + `execCommand("copy")` path,
 * which still works there, and put the focus back where it was (the button is
 * routinely next to an input the user is typing in).
 */
async function writeClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    /* no clipboard API, or the permission was refused — try the old way */
  }
  const active = document.activeElement as HTMLElement | null;
  const ta = document.createElement("textarea");
  ta.value = value;
  ta.setAttribute("readonly", "");
  // Off-screen but still selectable; `display:none` would make select() a no-op.
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  try {
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    active?.focus?.();
  }
}

export function CopyButton({
  value,
  className,
  size = "icon-sm",
  label,
}: {
  value: string;
  className?: string;
  size?: "icon" | "icon-sm" | "sm";
  label?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    if (!(await writeClipboard(value))) {
      // Both paths are gone (a hardened browser). Say so — a button that
      // reports nothing reads as "copied" and the value never arrives.
      toast.error("Couldn't copy — select the text and copy it manually");
      return;
    }
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
