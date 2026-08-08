"use client";

import * as React from "react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KEY_RE, parseEnv } from "@/components/env/env-parse";

export type EnvRow = { key: string; value: string };

/** The three columns every row of the key/value editor lines up on. */
const GRID = "grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_2rem] items-center gap-2";

/** The rows that carry a name - the ones a save would actually write. */
export function filledRows(rows: EnvRow[]): EnvRow[] {
  return rows.filter((r) => r.key.trim() !== "");
}

/** The named rows whose name isn't a legal variable name. */
export function invalidRows(rows: EnvRow[]): EnvRow[] {
  return filledRows(rows).filter((r) => !KEY_RE.test(r.key.trim()));
}

/**
 * The multi-row key/value editor: the one place a batch of variables is typed
 * in, shared by "Add variables" and "Add preview overrides" so adding five of
 * either is the same gesture.
 *
 * The rows are a small TABLE, not a stack of loose inputs: two labelled columns
 * the eye can run down, and cells that carry no border of their own - the same
 * shape the variables table shows them in afterwards. It renders the invalid-name
 * warning itself (it is about these rows); the caller reads {@link invalidRows}
 * to hold its own submit button closed.
 */
export function EnvRowsEditor({
  rows,
  onChange,
  keyPlaceholder = "KEY",
}: {
  rows: EnvRow[];
  onChange: (rows: EnvRow[]) => void;
  keyPlaceholder?: string;
}) {
  const invalid = invalidRows(rows);

  function setRow(i: number, patch: Partial<EnvRow>) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeRow(i: number) {
    if (rows.length > 1) onChange(rows.filter((_, idx) => idx !== i));
  }

  // Pasting `.env` content into a key field explodes into editable rows. A key can
  // never contain "=", so ANY paste that parses into at least one KEY=VALUE pair is
  // a .env paste - including the single most common case, one `KEY=value` line.
  // A paste with no "=" is just a key name and falls through to the normal paste.
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
        {/* Same px-2 as the rows, and the labels carry the cells' own px-1.5:
            the two grids then land on the very same tracks, so KEY sits over
            the keys and VALUE over the values, to the pixel. */}
        <div
          className={cn(
            GRID,
            "bg-secondary/40 px-2 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
          )}
        >
          <span className="px-1.5">Key</span>
          <span className="px-1.5">Value</span>
          <span aria-hidden />
        </div>

        {rows.map((r, i) => {
          const bad = r.key.trim() !== "" && !KEY_RE.test(r.key.trim());
          return (
            <div
              key={i}
              className={cn(GRID, "px-2 py-1.5", bad && "bg-destructive/5")}
            >
              <Input
                value={r.key}
                onChange={(e) => setRow(i, { key: e.target.value })}
                onPaste={(e) => onPaste(i, e)}
                placeholder={keyPlaceholder}
                aria-invalid={bad}
                autoFocus={i === 0}
                className={cn(
                  "h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0",
                  bad && "text-destructive focus-visible:ring-destructive",
                )}
              />
              <Input
                value={r.value}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder="value"
                className="h-8 border-0 bg-transparent px-1.5 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-offset-0"
              />
              {/* Kept in the layout, hidden while it would do nothing: the last
                  row can't be removed, and a column that comes and goes would
                  shift every input under the cursor. */}
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
            </div>
          );
        })}

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
