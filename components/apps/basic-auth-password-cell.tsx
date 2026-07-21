"use client";

import * as React from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { CopyButton } from "@/components/shared/copy-button";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";

// The hidden-value placeholder — the same dots the variables table uses, so a
// covered password reads identically wherever a secret is shown.
const MASK = "••••••••••••";

// The chip owns no width of its own and its contents are ABSOLUTELY positioned,
// so a long password contributes zero intrinsic width: the card stays the same
// size covered or revealed, and the value just truncates. `h-7` gives the
// out-of-flow box its height.
const OUTER =
  "relative block h-7 min-w-0 flex-1 rounded-md ring-1 ring-inset align-middle";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";

/**
 * The password of one basic-auth credential — masked, with a deliberate reveal.
 *
 * Unlike an app secret, a basic-auth password is a credential you HAND TO A
 * PERSON, so it can be read back (see `revealBasicAuthPassword`): otherwise
 * "what was the password again?" can only be answered by overwriting it and
 * locking out everyone already using it.
 *
 * The plaintext is FETCHED ON DEMAND and never rides the page's props: until
 * someone clicks the eye, the password is not in the DOM, not in a `title`, and
 * not in the RSC payload. Hiding it drops the value from state entirely — the
 * next reveal is a fresh, separately-authorised round-trip — and one card is
 * uncovered at a time (there is no "reveal all"). The reveal is a mutation, so
 * it is never cached or prefetched.
 */
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
      // A drag to copy the password leaves a selection behind; don't let the
      // click that ends it also slam the chip shut.
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
    // A password that can't be decrypted (rotated DEPLO_SECRET, restored dump)
    // comes back as an error, not as an empty string — surface it verbatim so
    // the fix ("set a new password") is the message itself. `data` is optional on
    // the shared ActionResult, so an `ok` with nothing in it stays covered rather
    // than flashing an empty chip.
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
          revealed ? `Hide ${username}'s password` : `Reveal ${username}'s password`
        }
        // No password in the title either — a tooltip is a DOM attribute, and the
        // whole point is that the value is nowhere in the DOM until revealed.
        title={revealed ? "Click to hide" : "Click to reveal"}
        className={cn(
          OUTER,
          "group cursor-pointer text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          revealed
            ? "ring-border/40 hover:bg-foreground/[0.03]"
            : "bg-foreground/[0.06] ring-border/50 hover:bg-foreground/[0.09]",
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
            <code className="min-w-0 flex-1 select-text truncate font-mono text-xs text-foreground/90">
              {value}
            </code>
          ) : (
            // Placeholder ONLY. Nothing in this subtree — text or attribute —
            // carries the password while it is hidden.
            <code
              aria-hidden
              className="min-w-0 flex-1 select-none truncate font-mono text-xs tracking-wider text-muted-foreground"
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
