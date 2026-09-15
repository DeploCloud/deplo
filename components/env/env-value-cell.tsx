"use client";

import * as React from "react";
import { RevealChip } from "@/components/shared/reveal-chip";

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
