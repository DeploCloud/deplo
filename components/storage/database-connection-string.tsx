"use client";

import * as React from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RevealChip } from "@/components/shared/reveal-chip";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

/**
 * The connection string of one database, presented exactly like an env-var value
 * on the Variables page: the same `RevealChip`, covered by default, opened one
 * click at a time.
 *
 * The difference from an env var is where the value comes from. A variable's
 * value rides the row's props; a connection string carries the database password
 * and is NEVER sent with the row — the covered chip shows the server-side mask
 * (`postgres://user:••••••@host:5432/db`, so the endpoint still reads at a
 * glance) and the real string is fetched on demand through the `manage_infra`
 * gated `revealConnection` mutation. It is cached in state for the life of the
 * chip, so toggling it shut and open again doesn't re-fetch.
 *
 * The copy button resolves the string the same way, which means a user can put
 * it on the clipboard WITHOUT ever putting it on screen — the friendlier move
 * while screen-sharing, and one click instead of two.
 */
export function DatabaseConnectionString({
  id,
  masked,
  canReveal = true,
  className,
}: {
  id: string;
  /** `connectionStringMasked` — what the chip shows while covered. */
  masked: string;
  /** The viewer holds `manage_infra`; false drops the affordances entirely. */
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
      // Surface the server's own message — "You don't have permission…" and
      // "Database not found" both mean something specific to the user.
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
      <RevealChip readOnly placeholder={masked} className={cn("min-w-0", className)} />
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

/** Copy the connection string, fetching it first if it hasn't been revealed. */
function CopyConnection({ resolve }: { resolve: () => Promise<string | null> }) {
  const [copied, setCopied] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const timer = React.useRef<number | undefined>(undefined);
  React.useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    setBusy(true);
    const v = await resolve();
    setBusy(false);
    if (v === null) return; // resolve() already reported why
    try {
      await navigator.clipboard.writeText(v);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to the clipboard");
    }
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
