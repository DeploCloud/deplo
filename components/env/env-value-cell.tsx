"use client";

import * as React from "react";
import { RevealChip } from "@/components/shared/reveal-chip";

// EnvValueCell - one env-var row's value as a click-to-reveal chip; a secret is masked.
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
