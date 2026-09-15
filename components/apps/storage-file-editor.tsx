"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { FolderOpen, RotateCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/info-tip";
import { languageForPath } from "@/components/apps/editor-language";
import type { StorageFileDraft } from "@/lib/apps/storage-file-model";
import { cn } from "@/lib/utils";

const TextEditor = dynamic(
  () => import("./text-editor").then((m) => m.TextEditor),
  { ssr: false, loading: () => <EditorSkeleton /> },
);

const EDITOR_MIN_HEIGHT = 220;

export function StorageFileEditor({
  path,
  state,
  canManageFiles,
  onChange,
  onRetry,
}: {
  path: string;
  state: StorageFileDraft | undefined;
  canManageFiles: boolean;
  onChange: (text: string) => void;
  onRetry: () => void;
}) {
  const label = (
    <FieldLabel
      className="text-xs"
      info="What Deplo writes into the file. The app sees the new contents on its next deploy."
      docs="storage.source"
    >
      What&apos;s in the file
    </FieldLabel>
  );

  if (!canManageFiles) {
    return (
      <Section label={label}>
        <Note icon={ShieldAlert} tone="warning">
          Writing this file needs the &quot;Manage files&quot; capability, which
          your account doesn&apos;t have. An admin grants it in Settings →
          Users. You can still say where the file goes.
        </Note>
      </Section>
    );
  }

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
        badge={
          !path ? null : current.exists ? (
            current.draft !== current.saved ? (
              <Badge variant="secondary">Unsaved edit</Badge>
            ) : null
          ) : (
            <Badge variant="outline">Deplo creates this file</Badge>
          )
        }
      >
        <TextEditor
          value={current.draft}
          onChange={onChange}
          minHeight={EDITOR_MIN_HEIGHT}
          language={languageForPath(path)}
        />
      </Section>
    );
  }

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
        language={languageForPath(path)}
      />
    </Section>
  );
}

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
      ? "border-warning/40 bg-warning-wash-strong text-warning"
      : tone === "destructive"
        ? "border-destructive/40 bg-destructive-wash-strong text-destructive"
        : "border-border bg-surface text-muted-foreground";
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

function EditorSkeleton() {
  return (
    <div
      className="animate-pulse rounded-lg border border-input bg-surface"
      style={{ minHeight: EDITOR_MIN_HEIGHT }}
      aria-hidden
    />
  );
}
