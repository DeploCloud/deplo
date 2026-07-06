"use client";

import * as React from "react";
import { Check, Folder, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cn,
  isHexColor,
  normalizeHexColor,
  readableTextColor,
} from "@/lib/utils";
import { FOLDER_COLORS } from "@/lib/folder-colors";
import { SimpleTooltip } from "@/components/ui/tooltip";

/**
 * Controlled colour picker for a folder: a row of curated swatches (plus a
 * "default / no colour" choice) and a free-form HEX field with a native colour
 * input and a live contrast preview. `value` is the canonical `#rrggbb` (or
 * null for the default neutral tile); `onChange` only ever fires with a
 * normalised colour or null, so callers can persist it verbatim. The readable
 * foreground is computed via {@link readableTextColor} so a custom colour can
 * never be unreadable.
 */
export function FolderColorPicker({
  value,
  onChange,
  idPrefix = "folder-color",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  idPrefix?: string;
}) {
  // The HEX field keeps its own text state so a half-typed value ("#3b8") never
  // clobbers the committed colour; we lift a value up only once it parses. The
  // dialog hosting this picker remounts on open (Radix unmounts closed content),
  // so the initial `value` always seeds `hex` — no value→hex sync effect needed,
  // and every interaction below keeps the two in step explicitly.
  const [hex, setHex] = React.useState(value ?? "");

  const current = (value ?? "").toLowerCase();
  const selectedSwatch = FOLDER_COLORS.find((c) => c.value === current);
  const isCustom = value != null && !selectedSwatch;
  const invalid = hex.trim() !== "" && !isHexColor(hex);

  /** Choose a swatch / the default — sets both the field text and the value. */
  function pick(next: string | null) {
    setHex(next ?? "");
    onChange(next);
  }

  /** Free-form HEX typing — keep the raw text, lift up only once it parses. */
  function commitHex(next: string) {
    setHex(next);
    const trimmed = next.trim();
    if (!trimmed) {
      onChange(null);
      return;
    }
    if (isHexColor(trimmed)) onChange(normalizeHexColor(trimmed));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {/* Default: clears the colour back to the neutral tile. */}
        <SimpleTooltip content="Default (no colour)">
          <button
            type="button"
            onClick={() => pick(null)}
            aria-label="Default (no colour)"
            aria-pressed={value == null}
            className={cn(
              "flex size-8 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground transition",
              value == null
                ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                : "hover:opacity-80",
            )}
          >
            <X className="size-4" />
          </button>
        </SimpleTooltip>
        {FOLDER_COLORS.map((c) => {
          const active = current === c.value;
          return (
            <SimpleTooltip key={c.value} content={c.name}>
              <button
                type="button"
                onClick={() => pick(c.value)}
                aria-label={c.name}
                aria-pressed={active}
                style={{
                  backgroundColor: c.value,
                  color: readableTextColor(c.value),
                }}
                className={cn(
                  "flex size-8 cursor-pointer items-center justify-center rounded-md border border-black/10 transition",
                  active
                    ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                    : "hover:opacity-80",
                )}
              >
                {active && <Check className="size-4" />}
              </button>
            </SimpleTooltip>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-hex`}>Custom colour</Label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Pick a custom colour"
            value={value && isHexColor(value) ? normalizeHexColor(value) : "#3b82f6"}
            onChange={(e) => commitHex(e.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-transparent p-0.5"
          />
          <Input
            id={`${idPrefix}-hex`}
            value={hex}
            onChange={(e) => commitHex(e.target.value)}
            placeholder="#3b82f6"
            spellCheck={false}
            aria-invalid={invalid}
          />
          {/* Live contrast preview — the icon colour is auto-derived. */}
          <div
            className="flex size-9 shrink-0 items-center justify-center rounded-md border border-black/10"
            style={
              value
                ? { backgroundColor: value, color: readableTextColor(value) }
                : undefined
            }
          >
            <Folder
              className={cn("size-4", !value && "text-muted-foreground")}
            />
          </div>
        </div>
        {invalid ? (
          <p className="text-xs text-destructive">
            Enter a valid hex colour, e.g. #3b82f6.
          </p>
        ) : isCustom ? (
          <p className="text-xs text-muted-foreground">
            Text and icon contrast is chosen automatically for readability.
          </p>
        ) : null}
      </div>
    </div>
  );
}
