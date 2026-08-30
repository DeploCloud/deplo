"use client";

import * as React from "react";
import { RevealChip } from "@/components/shared/reveal-chip";

/**
 * The value cell for one env-var row - a click-to-reveal chip (`RevealChip`,
 * shared with the database connection string so both read identically). - secret
 * var → write-only: the server sends the MASK, never the value.
 */
export function EnvValueCell({
  value,
  masked,
}: {
  value: string;
  masked: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);

  if (masked)
    return <RevealChip locked placeholderClassName="tracking-wider" />;

  return (
    <RevealChip
      value={value}
      revealed={revealed}
      onToggle={() => setRevealed((r) => !r)}
      placeholderClassName="tracking-wider"
    />
  );
}
