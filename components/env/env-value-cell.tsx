"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts, so a hidden plain var and a secret read the same.
const MASK = "••••••••••••";

/**
 * The value cell for one env-var row. EVERY value is hidden by default — there is
 * no "plain values are always visible" path.
 *
 *  - plain var  → the decrypted value rides the DTO; the eye is a real toggle that
 *                 reveals/hides it locally (nothing is fetched on reveal).
 *  - secret var → write-only: the value never reaches the client, so the eye is a
 *                 disabled, non-interactive indicator with no reveal path.
 *
 * Reveal state is uncontrolled by default (each cell owns it). Pass `revealed` +
 * `onRevealedChange` to control it from a parent — e.g. the service table's
 * "Reveal all" toggle drives every plain row at once.
 */
export function EnvValueCell({
  value,
  masked,
  revealed: revealedProp,
  onRevealedChange,
}: {
  value: string;
  masked: boolean;
  revealed?: boolean;
  onRevealedChange?: (revealed: boolean) => void;
}) {
  const [internal, setInternal] = React.useState(false);
  const revealed = revealedProp ?? internal;

  function toggle() {
    const next = !revealed;
    if (revealedProp === undefined) setInternal(next);
    onRevealedChange?.(next);
  }

  if (masked) {
    return (
      <div className="flex items-center gap-1.5">
        <code className="max-w-[220px] truncate font-mono text-xs text-muted-foreground">
          {MASK}
        </code>
        <Eye
          className="size-3.5 shrink-0 cursor-not-allowed text-muted-foreground opacity-50"
          aria-label="Secret value (hidden)"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <code
        title={revealed ? value : undefined}
        className="max-w-[220px] truncate font-mono text-xs text-muted-foreground"
      >
        {revealed ? value : MASK}
      </code>
      <button
        type="button"
        onClick={toggle}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        aria-label={revealed ? "Hide value" : "Reveal value"}
        aria-pressed={revealed}
      >
        {revealed ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Eye className="size-3.5" />
        )}
      </button>
    </div>
  );
}
