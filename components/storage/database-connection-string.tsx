"use client";

import * as React from "react";
import { toast } from "sonner";
import { RevealChip } from "@/components/shared/reveal-chip";
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
    <RevealChip
      className={cn("min-w-0", className)}
      placeholder={masked}
      value={value}
      revealed={revealed}
      pending={pending}
      onToggle={toggle}
      onCopy={resolve}
      copyLabel="Copy connection string"
      labels={{
        reveal: "Reveal connection string",
        hide: "Hide connection string",
      }}
    />
  );
}
