"use client";

import { ConfirmAction } from "@/components/shared/confirm-action";

const SHOWN = 5;

export function ReplaceExistingConfirm({
  keys,
  noun,
  onClose,
  onConfirm,
}: {
  keys: string[];
  noun: "variable" | "override";
  onClose: () => void;
  onConfirm: () => void;
}) {
  const n = keys.length;
  const list =
    n > SHOWN
      ? `${keys.slice(0, SHOWN).join(", ")} and ${n - SHOWN} more`
      : keys.join(", ");
  return (
    <ConfirmAction
      open={n > 0}
      onOpenChange={(v) => !v && onClose()}
      title={
        n === 1
          ? `Replace an existing ${noun}?`
          : `Replace ${n} existing ${noun}s?`
      }
      description={
        <>
          <strong>
            {n === 1 ? "This key already exists" : "These keys already exist"}
          </strong>{" "}
          and the new {n === 1 ? "value replaces it" : "values replace them"}.
        </>
      }
      consequence={`The current ${n === 1 ? "value is" : "values are"} lost: ${list}.`}
      confirmLabel="Replace"
      optimistic
      onConfirm={async () => {
        onConfirm();
        return { ok: true };
      }}
    />
  );
}
