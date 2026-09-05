"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/**
 * The TOTP setup key, covered until asked for - the same bargain as an environment
 * variable's value. Covering it matters more here than the usual "secret" reflex
 * suggests.
 */
export function SetupKey({ secret }: { secret: string }) {
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Grouped for hand-typing: nobody transcribes 52 unbroken base32 characters.
  const grouped = React.useMemo(
    () => secret.replace(/(.{4})/g, "$1 ").trim(),
    [secret],
  );
  // The cover is built to the SAME shape, so revealing does not reflow the
  // dialog under the pointer that just clicked.
  const cover = React.useMemo(
    () =>
      Array.from({ length: Math.ceil(secret.length / 4) }, () => "••••").join(
        " ",
      ),
    [secret.length],
  );

  async function copy() {
    if (!(await copyText(secret))) return;
    setCopied(true);
    toast.success("Setup key copied");
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          TOTP setup key
        </span>
        <InfoTip
          content="Your authenticator app may call this the secret, the key or the setup code. It is what the QR code carries."
          docs="team.twoFactor"
        />
      </div>

      {/* Two branches, never one element with a swapped string: while covered,
          `secret` is not referenced in the rendered tree at all. */}
      {revealed ? (
        <code className="block font-mono text-xs leading-relaxed break-all select-all">
          {grouped}
        </code>
      ) : (
        <code
          aria-hidden
          className={cn(
            "block font-mono text-xs leading-relaxed break-all",
            "text-muted-foreground/70 select-none",
          )}
        >
          {cover}
        </code>
      )}
      {!revealed && <span className="sr-only">Setup key hidden</span>}

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-pressed={revealed}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? (
            <EyeOff className="size-3.5" />
          ) : (
            <Eye className="size-3.5" />
          )}
          {revealed ? "Hide" : "Show"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={copy}
        >
          {copied ? (
            <Check className="size-3.5 text-[var(--success)]" />
          ) : (
            <Copy className="size-3.5" />
          )}
          Copy
        </Button>
      </div>
    </div>
  );
}
