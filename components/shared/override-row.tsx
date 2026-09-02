"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/shared/setting-row";
import { cn } from "@/lib/utils";
import type { DocsTopic } from "@/lib/docs";

/**
 * A setting Deplo works out for you, with the answer on show and a switch to
 * take it over. The value it WOULD use is the whole point: an empty box behind
 * a "(auto-detected)" placeholder needs a paragraph to explain itself, and this
 * needs none.
 *
 * `null` is "not overridden". An empty string is a deliberate empty value, and
 * the two are different on purpose.
 */
export function OverrideRow({
  label,
  info,
  docs,
  id,
  detected,
  detectedLabel = "Worked out at build time",
  value,
  onChange,
  placeholder,
  /** A consequence of the current value, shown because it is one. */
  note,
  mono = true,
  disabled,
  control,
}: {
  label: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  id?: string;
  /** What Deplo would use on its own, when that is knowable up front. */
  detected?: string;
  /** Shown in place of `detected` when the value is only settled at build time.
   * Never invent a command here: a wrong one reads as a promise. */
  detectedLabel?: string;
  /** `null` while Deplo decides; a string once the caller has taken over. */
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  note?: string;
  mono?: boolean;
  disabled?: boolean;
  /** A control other than a text input (a combobox, a number field). */
  control?: (props: {
    value: string;
    onChange: (next: string) => void;
    id?: string;
    disabled?: boolean;
  }) => React.ReactNode;
}) {
  const on = value !== null;

  function toggle(next: boolean) {
    onChange(next ? (value ?? detected ?? "") : null);
  }

  const row = (
    <SettingRow
      label={label}
      info={info}
      docs={docs}
      htmlFor={on ? id : undefined}
      align={on ? "start" : "center"}
    >
      <div className="flex min-w-0 flex-1 items-start justify-end gap-3">
        {on ? (
          control ? (
            control({
              value: value ?? "",
              onChange,
              id,
              disabled,
            })
          ) : (
            <Input
              id={id}
              className={cn("max-w-xs", mono && "font-mono text-xs")}
              placeholder={placeholder}
              value={value ?? ""}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          )
        ) : (
          <span
            className={cn(
              "truncate text-sm text-muted-foreground",
              detected?.trim() && mono && "font-mono text-xs",
            )}
          >
            {detected?.trim() || detectedLabel}
          </span>
        )}
        <Switch
          checked={on}
          onCheckedChange={toggle}
          disabled={disabled}
          aria-label={`Override ${label.toLowerCase()}`}
          className="mt-1 shrink-0"
        />
      </div>
    </SettingRow>
  );

  if (!note || !on) return row;

  return (
    <div>
      {row}
      <p className="mt-1 flex items-start gap-1.5 px-3 text-xs text-warning">
        <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {note}
      </p>
    </div>
  );
}
