"use client";

import * as React from "react";
import { RevealChip } from "@/components/shared/reveal-chip";

/**
 * The value cell for one env-var row — a click-to-reveal chip (`RevealChip`,
 * shared with the database connection string so both read identically).
 *
 *  - plain var  → the decrypted value rides the row's props, but it is NOT put in
 *                 the DOM while hidden: the covered chip renders only mask dots and
 *                 an eye, so inspect-element sees the mask, never the value.
 *                 Clicking mounts the real value (truncated, selectable); clicking
 *                 again unmounts it. Nothing is fetched — the value was in props.
 *  - secret var → write-only: the server sends the MASK, never the value. Masked
 *                 dots with a lock, and it never opens.
 *
 * Each cell owns its own reveal state: a value is uncovered one row at a time,
 * deliberately, and there is no bulk "reveal all".
 */
export function EnvValueCell({
  value,
  masked,
}: {
  value: string;
  masked: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);

  if (masked) return <RevealChip locked placeholderClassName="tracking-wider" />;

  return (
    <RevealChip
      value={value}
      revealed={revealed}
      onToggle={() => setRevealed((r) => !r)}
      placeholderClassName="tracking-wider"
    />
  );
}
