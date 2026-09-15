"use client";

import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RevealChip } from "@/components/shared/reveal-chip";
import { copyText } from "@/lib/clipboard";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

export function DatabaseConnectionString({
  id,
  masked,
  canReveal = true,
  className,
}: {
  id: string;
  masked: string;
  canReveal?: boolean;
  className?: string;
}) {
  const [revealed, setRevealed] = React.useState(false);
  const [value, setValue] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);

  const resolve = React.useCallback(async () => {
    if (value !== null) return value;
    setPending(true);
    const res = await gqlAction<{ revealConnection: string }, string>(
      `mutation($id: String!) { revealConnection(id: $id) }`,
      { id },
      (d) => d.revealConnection,
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    setValue(res.data ?? null);
    return res.data ?? null;
  }, [id, value]);

  function toggle() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    void resolve().then((v) => {
      if (v !== null) setRevealed(true);
    });
  }

  if (!canReveal) {
    return (
      <RevealChip
        readOnly
        placeholder={masked}
        className={cn("min-w-0", className)}
      />
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <RevealChip
        className="min-w-0 flex-1"
        placeholder={masked}
        value={value}
        revealed={revealed}
        pending={pending}
        onToggle={toggle}
        labels={{
          reveal: "Reveal connection string",
          hide: "Hide connection string",
        }}
      />
      <CopyConnection resolve={resolve} />
    </div>
  );
}

function CopyConnection({
  resolve,
}: {
  resolve: () => Promise<string | null>;
}) {
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    setBusy(true);
    const v = await resolve();
    setBusy(false);
    if (v === null) return;
    if (!(await copyText(v))) return;
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <SimpleTooltip content={copied ? "Copied" : "Copy connection string"}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Copy connection string"
        disabled={busy}
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={copy}
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : copied ? (
          <Check className="size-3.5 text-[var(--success)]" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
    </SimpleTooltip>
  );
}
