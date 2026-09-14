"use client";

import * as React from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KEY_RE, parseEnv } from "@/components/env/env-parse";

export type EnvRow = { key: string; value: string };

const GRID =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2rem] items-center gap-2";
const GRID_SINGLE =
  "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-2";

// filledRows - the rows that carry a name, the ones a save would actually write.
export function filledRows(rows: EnvRow[]): EnvRow[] {
  return rows.filter((r) => r.key.trim() !== "");
}

// invalidRows - the named rows whose name isn't a legal variable name.
export function invalidRows(rows: EnvRow[]): EnvRow[] {
  return filledRows(rows).filter((r) => !KEY_RE.test(r.key.trim()));
}

// EnvRowsEditor - the multi-row key/value editor shared by every batch-of-variables form.
export function EnvRowsEditor({
  rows,
  onChange,
  keyPlaceholder = "KEY",
  singleRow = false,
  keyDisabled = false,
  valueReadOnly = false,
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  keyPlaceholder?: string;
  singleRow?: boolean;
  keyDisabled?: boolean;
  valueReadOnly?: boolean;
}) {
  const invalid = invalidRows(rows);

  function setRow(i: number, patch: Partial<EnvRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    if (rows.length > 1) onChange(rows.filter((_, idx) => idx !== i));
  }

  function onPaste(i: number, e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    const parsed = parseEnv(text);
    if (parsed.length === 0) return;
    e.preventDefault();
    const kept = rows.filter((r, idx) => idx !== i && r.key.trim() !== "");
    const merged = [...kept];
    for (const p of parsed) {
      const at = merged.findIndex((r) => r.key === p.key);
      if (at >= 0) merged[at] = p;
      else merged.push(p);
    }
    onChange(merged.length ? merged : [{ key: "", value: "" }]);
  }

  return (
    <>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {/* Header and rows share one grid, so KEY sits over the keys. */}
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
              {/* Hidden, not unmounted: a column that comes and goes shifts every input. */}
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
            </div>
          );
        })}

        {!singleRow && (
          <div className="p-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange([...rows, { key: "", value: "" }])}
              className="h-8 w-full justify-start px-2 text-muted-foreground hover:text-foreground"
            >
              <Plus className="size-4" />
              Add another
            </Button>
          </div>
        )}
      </div>

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
