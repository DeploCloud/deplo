"use client";

import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { NOTE_VISIBLE } from "@/components/env/env-rows-editor";
import { NOTE_MAX } from "@/lib/env-file";

export function NoteField({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        info={`At most ${NOTE_MAX} characters. A note is never deployed, so changing it needs no redeploy.`}
        docs="env.notes"
      >
        Note
      </FieldLabel>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="What is this variable for?"
        maxLength={NOTE_MAX}
        autoFocus={autoFocus}
      />
      <p className="text-xs text-muted-foreground">{NOTE_VISIBLE}</p>
    </div>
  );
}
