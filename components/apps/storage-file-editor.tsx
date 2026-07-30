"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { FolderOpen, RotateCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import type { StorageFileDraft } from "@/lib/apps/storage-file-model";
import { cn } from "@/lib/utils";

/**
 * What a **File** storage entry actually contains — the box you write the file
 * in, right under the two paths that say where it goes.
 *
 * WHY IT EXISTS. A File entry used to ask only for a path in this app's Files,
 * which meant the file had to already be there: go to the Files tab, create
 * `config.toml`, type it, come back to Storage, point an entry at it. Anyone who
 * had not already made the file got an entry pointing at nothing — and a mount
 * whose source does not exist is the one Docker footgun that fails silently, by
 * inventing an empty DIRECTORY where the app expected a config file. So the
 * entry now asks for the content too, and the save writes it (Dokploy's File
 * Mount does the same: file path, mount path, content).
 *
 * THE BOX IS ALWAYS THERE. It does not wait for the entry to be named first —
 * asking for a path before offering the editor put the two in the wrong order
 * (you know what you want to write long before you know where it goes) and made
 * the box look broken until an unrelated field was filled. Text written before
 * the entry has a path is held in the form, read from nowhere and written
 * nowhere, and carried over the moment the entry names a file. Nothing is saved
 * until the whole entry is complete and Save is pressed.
 *
 * ONE FILE, ONE TRUTH. The content is not a copy kept in deplo's database: it is
 * read from, and written to, the very file the Files tab shows — the same agent
 * RPCs, on the app's own server. So an edit made in either place is the one the
 * app gets, and neither view can go stale against the other.
 *
 * Presentational: the parent form owns the reads, the drafts and the save (see
 * `storage-settings-form.tsx`), so this file never fetches.
 */

/**
 * The editor is CodeMirror (~40KB) and most apps have no File entry at all, so
 * it is code-split and never enters SSR — the Storage page pays for it only when
 * a File entry is actually on screen. Same reasoning as `xterm-lazy.tsx`.
 */
const TextEditor = dynamic(
  () => import("./text-editor").then((m) => m.TextEditor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

/** How tall the box is before it scrolls — a config file, not a manuscript. */
const EDITOR_MIN_HEIGHT = 220;

export function StorageFileEditor({
  path,
  state,
  canManageFiles,
  onChange,
  onRetry,
}: {
  /** The row's CURRENT path in Files, normalised. Empty ⇒ not named yet. */
  path: string;
  /** Undefined until the row has either been typed into or read. */
  state: StorageFileDraft | undefined;
  /**
   * Whether the viewer may read and write this app's files. COSMETIC — the
   * authoritative gate is the `manage_files` capability on the `appStorageFile`
   * query and the `writeAppFile` mutation.
   */
  canManageFiles: boolean;
  onChange: (text: string) => void;
  onRetry: () => void;
}) {
  const label = (
    <FieldLabel
      className="text-xs"
      info="What deplo writes into the file. It is the same file the Files tab shows, so an edit here and an edit there are the same edit. The app sees the new contents on its next deploy."
    >
      What&apos;s in the file
    </FieldLabel>
  );

  if (!canManageFiles) {
    return (
      <Section label={label}>
        <Note icon={ShieldAlert} tone="warning">
          Writing this file needs the &quot;Manage files&quot; capability, which
          your account doesn&apos;t have. An admin grants it in Settings → Users.
          You can still say where the file goes.
        </Note>
      </Section>
    );
  }

  // The read that matches the entry's CURRENT path — undefined while a path edit
  // is still being re-read, and for an entry that has no path at all.
  const current = state && state.path === path ? state : undefined;

  if (current?.status === "error") {
    return (
      <Section label={label}>
        <Note icon={TriangleAlert} tone="destructive">
          <span className="min-w-0 flex-1">{current.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onRetry}
          >
            <RotateCw className="size-3.5" />
            Try again
          </Button>
        </Note>
      </Section>
    );
  }

  if (current?.status === "blocked") {
    return (
      <Section label={label}>
        <Note icon={FolderOpen}>{current.message}</Note>
      </Section>
    );
  }

  if (current?.status === "editable") {
    return (
      <Section
        label={label}
        // An entry with no path yet has no file to describe, so it gets no badge
        // — only the box.
        badge={
          !path ? null : current.exists ? (
            current.draft !== current.saved ? (
              <Badge variant="secondary">Unsaved edit</Badge>
            ) : null
          ) : (
            <Badge variant="outline">deplo creates this file</Badge>
          )
        }
      >
        <TextEditor
          value={current.draft}
          onChange={onChange}
          minHeight={EDITOR_MIN_HEIGHT}
        />
      </Section>
    );
  }

  // Nothing has been read for this path. The box is on screen anyway, because
  // text written before the entry was named must not blink away behind a
  // skeleton while the read for its new path lands — `loadFile` carries it over
  // as the unsaved draft, so what is shown here is what will be kept.
  const carried =
    state?.status === "editable" && state.draft !== state.saved
      ? state.draft
      : null;
  if (path && carried === null) {
    return (
      <Section label={label}>
        <EditorSkeleton />
      </Section>
    );
  }
  return (
    <Section label={label}>
      <TextEditor
        value={carried ?? ""}
        onChange={onChange}
        minHeight={EDITOR_MIN_HEIGHT}
      />
    </Section>
  );
}

/** Label row + body, so every state lines up under the same heading. */
function Section({
  label,
  badge,
  children,
}: {
  label: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <div className="flex flex-wrap items-center gap-2">
        {label}
        {badge}
      </div>
      {children}
    </div>
  );
}

function Note({
  icon: Icon,
  tone = "muted",
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  tone?: "muted" | "warning" | "destructive";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warning"
      ? "border-warning/40 bg-warning/10 text-warning"
      : tone === "destructive"
        ? "border-destructive/40 bg-destructive/10 text-destructive"
        : "border-border bg-muted/30 text-muted-foreground";
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
        toneClass,
      )}
    >
      {Icon && <Icon className="mt-px size-3.5 shrink-0" />}
      {children}
    </p>
  );
}

/** The box's footprint while the file is being read, so nothing jumps. */
function EditorSkeleton() {
  return (
    <div
      className="animate-pulse rounded-lg border border-input bg-muted/30"
      style={{ minHeight: EDITOR_MIN_HEIGHT }}
      aria-hidden
    />
  );
}
