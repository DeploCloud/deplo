"use client";

import * as React from "react";

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
  value,
  onChange,
  placeholder,
  mono = true,
  disabled,
  control,
}: {
  label: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  id?: string;
  /** What Deplo would use on its own. Empty when it could not work it out. */
  detected?: string;
  /** `null` while Deplo decides; a string once the caller has taken over. */
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
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
  // Nothing detected means there is nothing to show instead, so the field opens
  // itself rather than presenting an empty promise.
  const nothingDetected = !detected?.trim();

  function toggle(next: boolean) {
    onChange(next ? (value ?? detected ?? "") : null);
  }

  return (
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
              mono && "font-mono text-xs",
            )}
          >
            {nothingDetected ? "Nothing to run" : detected}
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
}
