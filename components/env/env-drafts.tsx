"use client";

import * as React from "react";
import {
  ChevronRight,
  Info,
  MessageSquareText,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { NOTE_MAX } from "@/lib/env-file";
import { ENV_LIST_COLS } from "@/components/env/env-list";
import {
  draftTag,
  hasContent,
  invalidDraft,
  pasteIntoDrafts,
  savableDrafts,
  type Draft,
  type DraftTag,
  type KnownVar,
} from "@/components/env/env-drafts-model";

const TAG: Record<
  Exclude<DraftTag, null>,
  { label: string; className: string }
> = {
  fills: {
    label: "Fills a missing value",
    className: "bg-success-wash text-[var(--success)]",
  },
  replaces: {
    label: "Replaces the current value",
    className: "bg-warning-wash-strong text-warning",
  },
  "secret-taken": {
    label: "A secret has this name",
    className: "bg-destructive-wash-strong text-destructive",
  },
  loose: {
    label: "Check this note",
    className: "bg-warning-wash-strong text-warning",
  },
};

const DISCARD = "Discard the variables you have not saved?";

// The browser asks before a reload or a closed tab; a click on a link inside Deplo asks too.
export function useLeaveGuard(active: boolean) {
  React.useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.defaultPrevented) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
      if (new URL(a.href).origin !== window.location.origin) return;
      if (!window.confirm(DISCARD)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);
}

export function EnvDraftRows({
  drafts,
  onChange,
  known,
  onSave,
}: {
  drafts: Draft[];
  onChange: (drafts: Draft[]) => void;
  known: KnownVar[];
  onSave: (drafts: Draft[]) => void;
}) {
  const single = drafts.length === 1;
  const savable = savableDrafts(drafts);
  const blocked = drafts.some(invalidDraft) || savable.length === 0;
  const loose = drafts.filter((d) => draftTag(d, known) === "loose").length;
  useLeaveGuard(drafts.some(hasContent));

  const set = (id: string, patch: Partial<Draft>) =>
    onChange(drafts.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const drop = (id: string) => onChange(drafts.filter((d) => d.id !== id));

  return (
    <form
      className="divide-y divide-border"
      onSubmit={(e) => {
        e.preventDefault();
        if (!blocked) onSave(savable);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && single) onChange([]);
      }}
    >
      {drafts.map((d, i) => (
        <DraftRow
          key={d.id}
          draft={d}
          tag={draftTag(d, known)}
          first={i === 0}
          single={single}
          blocked={blocked}
          onSet={(patch) => set(d.id, patch)}
          onDrop={() => (single ? onChange([]) : drop(d.id))}
          onPaste={(text) => pasteIntoDrafts(drafts, d.id, text)}
          onPasted={onChange}
        />
      ))}
      {!single && (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-popover py-1.5 pr-1.5 pl-4 shadow-lg">
            <span className="text-sm font-medium whitespace-nowrap">
              {savable.length} to save
            </span>
            {loose > 0 && (
              <span className="ml-1 text-xs whitespace-nowrap text-warning">
                {loose === 1 ? "1 note to check" : `${loose} notes to check`}
              </span>
            )}
            <span className="mx-1.5 h-5 w-px bg-border" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange([])}
            >
              Discard
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={blocked}
              className="rounded-full"
            >
              Save {savable.length}
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}

function DraftRow({
  draft: d,
  tag,
  first,
  single,
  blocked,
  onSet,
  onDrop,
  onPaste,
  onPasted,
}: {
  draft: Draft;
  tag: DraftTag;
  first: boolean;
  single: boolean;
  blocked: boolean;
  onSet: (patch: Partial<Draft>) => void;
  onDrop: () => void;
  onPaste: (text: string) => Draft[] | null;
  onPasted: (drafts: Draft[]) => void;
}) {
  const bad = invalidDraft(d);
  const lines = d.note ? d.note.split("\n").length : 0;
  return (
    <div
      className={cn(
        "shadow-[inset_2px_0_0_var(--info)]",
        d.open && "bg-surface",
      )}
    >
      <div
        className={cn(
          ENV_LIST_COLS,
          "flex flex-wrap items-center gap-2 px-3 py-2",
        )}
      >
        <span className="max-md:hidden" />
        <button
          type="button"
          onClick={() => onSet({ open: !d.open })}
          aria-expanded={d.open}
          aria-label={d.open ? "Hide note" : "Show note"}
          className="flex h-8 w-4 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", d.open && "rotate-90")}
          />
        </button>
        <Input
          value={d.key}
          onChange={(e) => onSet({ key: e.target.value })}
          onPaste={(e) => {
            const next = onPaste(e.clipboardData.getData("text"));
            if (!next) return;
            e.preventDefault();
            onPasted(next);
          }}
          placeholder="KEY"
          aria-label="Key"
          aria-invalid={bad}
          autoFocus={first && !d.key && !d.value}
          className={cn(
            "h-8 min-w-0 flex-1 basis-[calc(100%-2rem)] font-mono text-xs md:basis-auto",
            bad && "text-destructive focus-visible:ring-destructive",
          )}
        />
        <Input
          value={d.value}
          onChange={(e) => onSet({ value: e.target.value })}
          placeholder="value"
          aria-label="Value"
          className="h-8 min-w-0 basis-full font-mono text-xs md:basis-auto"
        />
        <div className="flex min-w-0 flex-1 items-center gap-3 md:col-span-2">
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={d.secret}
              onCheckedChange={(secret) => onSet({ secret })}
            />
            Secret
          </label>
          {tag ? (
            <span
              className={cn(
                "flex items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] whitespace-nowrap",
                TAG[tag].className,
              )}
            >
              {tag === "loose" && <MessageSquareText className="size-3" />}
              {TAG[tag].label}
            </span>
          ) : (
            lines > 0 &&
            !d.open && (
              <span className="flex items-center gap-1 truncate rounded-md bg-surface-strong px-1.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground">
                <MessageSquareText className="size-3" />
                {lines === 1 ? "Note, 1 line" : `Note, ${lines} lines`}
              </span>
            )
          )}
        </div>
        <div className="flex shrink-0 justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onDrop}
            aria-label={single ? "Cancel" : "Remove"}
            className="text-muted-foreground hover:text-destructive"
          >
            {single ? <X className="size-4" /> : <Trash2 className="size-4" />}
          </Button>
        </div>
      </div>
      {bad && (
        <p className="flex items-center gap-1.5 px-3 pb-2 text-xs text-destructive md:pl-[4.25rem]">
          <TriangleAlert className="size-3.5 shrink-0" />A name starts with a
          letter or underscore and holds only letters, digits and underscores.
        </p>
      )}
      {d.open && (
        <div className="space-y-2 px-3 pb-4 pl-9 md:pl-[4.25rem]">
          <Textarea
            value={d.note ?? ""}
            onChange={(e) => onSet({ note: e.target.value, noteLoose: false })}
            placeholder="Note: what is this variable for? Optional, and visible to your team."
            aria-label={`Note for ${d.key.trim() || "this variable"}`}
            maxLength={NOTE_MAX}
            rows={Math.min(5, Math.max(2, lines))}
            className="min-h-0 font-sans text-xs leading-relaxed"
          />
          {d.noteLoose && d.note && (
            <p className="flex items-center gap-1.5 text-xs text-warning">
              <TriangleAlert className="size-3.5 shrink-0" />A blank line
              separated this comment from the variable.
              <button
                type="button"
                onClick={() => onSet({ note: undefined, noteLoose: false })}
                className="cursor-pointer text-foreground underline underline-offset-2"
              >
                Remove
              </button>
            </p>
          )}
          {single && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Info className="size-3.5 shrink-0" />
                Paste a whole .env file into Key to add several at once.
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onDrop}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={blocked}>
                  Save
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      {!d.open && single && (
        <button type="submit" className="sr-only" tabIndex={-1}>
          Save
        </button>
      )}
    </div>
  );
}
