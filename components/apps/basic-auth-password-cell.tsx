"use client";

import * as React from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

const MASK = "••••••••••••";

const OUTER =
  "relative block h-7 min-w-0 flex-1 rounded-md ring-1 ring-inset align-middle";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";

// BasicAuthPasswordCell - one basic-auth password, masked with a deliberate reveal.
export function BasicAuthPasswordCell({
  id,
  username,
}: {
  id: string;
  username: string;
}) {
  const [value, setValue] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const revealed = value !== null;

  async function toggle() {
    if (revealed) {
      // A drag to copy leaves a selection; the click ending it must not shut the chip.
      if ((window.getSelection()?.toString().length ?? 0) > 0) return;
      setValue(null);
      return;
    }
    if (pending) return;
    setPending(true);
    const res = await gqlAction<{ revealBasicAuthPassword: string }, string>(
      `mutation($id: String!) { revealBasicAuthPassword(id: $id) }`,
      { id },
      (d) => d.revealBasicAuthPassword,
    );
    setPending(false);
    if (res.ok) setValue(res.data ?? null);
    else toast.error(res.error);
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={toggle}
        aria-pressed={revealed}
        aria-busy={pending}
        aria-label={
          revealed
            ? `Hide ${username}'s password`
            : `Reveal ${username}'s password`
        }
        // No password in the title: the value is nowhere in the DOM until revealed.
        title={revealed ? "Click to hide" : "Click to reveal"}
        className={cn(
          OUTER,
          "group cursor-pointer text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          revealed
            ? "ring-border/40 hover:bg-surface"
            : "bg-surface ring-border/50 hover:bg-surface",
        )}
      >
        <span className={INNER}>
          {pending ? (
            <Loader2
              aria-hidden
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
            />
          ) : revealed ? (
            <EyeOff
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
            />
          ) : (
            <Eye
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
            />
          )}
          {revealed ? (
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90 select-text">
              {value}
            </code>
          ) : (
            <code
              aria-hidden
              className="min-w-0 flex-1 truncate font-mono text-xs tracking-wider text-muted-foreground select-none"
            >
              {MASK}
            </code>
          )}
        </span>
      </button>
      {revealed && <CopyButton value={value} className="shrink-0" />}
    </div>
  );
}
