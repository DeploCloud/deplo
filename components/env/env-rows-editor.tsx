"use client";

import * as React from "react";
import { Info, Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KEY_RE, NOTE_MAX, parseEnvFile } from "@/lib/env-file";

// `note` undefined is a closed "Add note"; an empty string is an open, blank one.
export type EnvRow = { key: string; value: string; note?: string };

export const NOTE_VISIBLE =
  "Notes are visible to anyone who can see the variable, so never put a secret in one.";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2rem] items-center gap-2";
const GRID_SINGLE =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-2";

export function filledRows(rows: EnvRow[]): EnvRow[] {
  return rows.filter((r) => r.key.trim() !== "");
}

export function invalidRows(rows: EnvRow[]): EnvRow[] {
  return filledRows(rows).filter((r) => !KEY_RE.test(r.key.trim()));
}

export function EnvRowsEditor({
  rows,
  onChange,
  keyPlaceholder = "KEY",
  singleRow = false,
  keyDisabled = false,
  valueReadOnly = false,
  notes = false,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  keyPlaceholder?: string;
  singleRow?: boolean;
  keyDisabled?: boolean;
  valueReadOnly?: boolean;
  notes?: boolean;
}) {
  const invalid = invalidRows(rows);
  const [cut, setCut] = React.useState(0);

  function setRow(i: number, patch: Partial<EnvRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    if (rows.length > 1) onChange(rows.filter((_, idx) => idx !== i));
  }

  function onPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const parsed = parseEnvFile(text);
    if (parsed.length === 0) return;
    e.preventDefault();
    const kept = rows.filter((r, idx) => idx !== i && r.key.trim() !== "");
    const merged = [...kept];
    for (const { key, value, note } of parsed) {
      const at = merged.findIndex((r) => r.key === key);
      const row = {
        key,
        value,
        note: notes ? (note ?? merged[at]?.note) : undefined,
      };
      if (at >= 0) merged[at] = row;
      else merged.push(row);
    }
    if (notes) setCut(parsed.filter((p) => p.noteCut).length);
    onChange(merged.length ? merged : [{ key: "", value: "" }]);
  }

  return (
    <>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        <div
          className={cn(
            singleRow ? GRID_SINGLE : GRID,
            "bg-surface px-2 py-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase",
          )}
        >
          <span className="px-1.5">Key</span>
          <span className="px-1.5">Value</span>
          {!singleRow && <span aria-hidden />}
        </div>

        {rows.map((r, i) => {
          const bad = r.key.trim() !== "" && !KEY_RE.test(r.key.trim());
          return (
            <div
              key={i}
              className={cn(
                singleRow ? GRID_SINGLE : GRID,
                "px-2 py-1.5",
                bad && "bg-destructive-wash",
              )}
            >
              <Input
                value={r.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                onPaste={(e) => onPaste(i, e)}
                placeholder={keyPlaceholder}
                aria-invalid={bad}
                autoFocus={i === 0 && !keyDisabled}
                disabled={keyDisabled}
                className={cn(
                  "h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0",
                  bad && "text-destructive focus-visible:ring-destructive",
                )}
              />
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
                readOnly={valueReadOnly}
                autoFocus={i === 0 && keyDisabled && !valueReadOnly}
                className={cn(
                  "h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0",
                  valueReadOnly && "text-muted-foreground",
                )}
              />
              {!singleRow && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "text-muted-foreground hover:text-destructive",
                    rows.length === 1 && "invisible",
                  )}
                  onClick={() => removeRow(i)}
                  disabled={rows.length === 1}
                  aria-label="Remove row"
                >
                  <Trash2 className="size-4" />
                </Button>
              )}
              {notes &&
                (r.note === undefined ? (
                  <button
                    type="button"
                    onClick={() => setRow(i, { note: "" })}
                    className="col-span-2 flex items-center gap-1 justify-self-start rounded px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <Plus className="size-3" />
                    Add note
                  </button>
                ) : (
                  <Input
                    value={r.note}
                    onChange={(e) => setRow(i, { note: e.target.value })}
                    placeholder="What is this variable for?"
                    aria-label={`Note for ${r.key.trim() || "this variable"}`}
                    maxLength={NOTE_MAX}
                    autoFocus={r.note === ""}
                    className="col-span-2 h-7 border-0 bg-transparent px-1.5 text-xs text-muted-foreground shadow-none focus-visible:ring-1 focus-visible:ring-offset-0"
                  />
                ))}
            </div>
          );
        })}

        {!singleRow && (
          <div className="flex items-center gap-1 p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange([...rows, { key: "", value: "" }])}
              className="h-8 flex-1 justify-start px-2 text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-4" />
              Add another
            </Button>
            {rows.length > 1 && !keyDisabled && !valueReadOnly && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onChange([{ key: "", value: "" }])}
                className="text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-4" />
                Clear all
              </Button>
            )}
          </div>
        )}
      </div>

      {notes && rows.some((r) => r.note !== undefined) && (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" />
          <span>
            {cut > 0 &&
              `${cut === 1 ? "A pasted note was" : `${cut} pasted notes were`} longer than ${NOTE_MAX} characters and ${cut === 1 ? "was" : "were"} shortened. `}
            {NOTE_VISIBLE}
          </span>
        </p>
      )}

      {invalid.length > 0 && (
        <p className="flex items-start gap-2 text-xs text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {invalid.length === 1
              ? `“${invalid[0].key.trim()}” isn't a valid variable name.`
              : `${invalid.length} keys aren't valid variable names.`}{" "}
            Names must start with a letter or underscore and contain only
            letters, digits and underscores.
          </span>
        </p>
      )}
    </>
  );
}
