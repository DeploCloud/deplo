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

// Below md the value rides under its key: a column beside a monospace key is left no width at all.
export function EnvValueUnderKey(props: { value: string; masked: boolean }) {
  return (
    <div className="mt-1.5 md:hidden">
      <EnvValueCell {...props} />
    </div>
  );
}

export function EnvNoteUnderKey({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <p
      title={note}
      className="mt-1 max-w-64 truncate font-sans text-xs font-normal text-muted-foreground md:max-w-80"
    >
      {note}
    </p>
  );
}
