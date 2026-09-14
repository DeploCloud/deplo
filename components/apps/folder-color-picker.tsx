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

// FolderColorPicker - curated swatches plus a free-form HEX field for a folder.
export function FolderColorPicker({
  value,
  onChange,
  idPrefix = "folder-color",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  idPrefix?: string;
}) {
  const [hex, setHex] = React.useState(value ?? "");

  const current = (value ?? "").toLowerCase();
  const invalid = hex.trim() !== "" && !isHexColor(hex);

  function pick(next: string | null) {
    setHex(next ?? "");
    onChange(next);
  }

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
        {/* Default: no colour. */}
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
            value={
              value && isHexColor(value) ? normalizeHexColor(value) : "#3b82f6"
            }
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
          {/* Live contrast preview. */}
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
        ) : null}
      </div>
    </div>
  );
}
