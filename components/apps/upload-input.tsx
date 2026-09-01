"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, FileArchive, Loader2, CheckCircle2 } from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, ACCEPT_ATTR } from "@/lib/deploy/upload-shared";
import { validateArchive, uploadArchive } from "@/lib/deploy/upload-client";
import { useNow } from "@/components/shared/time-ago";

export interface CurrentUpload {
  filename: string;
  size: number;
  uploadedAt: string;
}

/**
 * Drag-and-drop / file-picker upload of a code archive for an "upload"-source
 * project. - Deferred mode (`onSelect` is passed, no app exists yet): the create
 * wizard captures the picked File and uploads it itself after the app is created.
 */
export function UploadInput({
  appId,
  current,
  onSelect,
  file,
}: {
  /** Settings mode: the existing app to stream the archive to. */
  appId?: string;
  /** Settings mode: the archive currently stored on the app, if any. */
  current?: CurrentUpload | null;
  /** Deferred mode: report the picked File (or null when cleared) to the parent. */
  onSelect?: (file: File | null) => void;
  /** Deferred mode, CONTROLLED: a file the parent already holds (one dropped on
   *  another page) so the chip shows it too. */
  file?: File | null;
}) {
  useNow();
  const router = useRouter();
  const deferred = typeof onSelect === "function";
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  // Deferred mode: the File held for the parent to upload post-create. A parent
  // that passes `file` owns it instead - the archive may have been picked on a
  // different page entirely.
  const [picked, setPicked] = React.useState<File | null>(null);
  const selected = file !== undefined ? file : picked;

  const uploading = progress !== null;

  function pick() {
    if (!uploading) inputRef.current?.click();
  }

  function handle(chosen: File) {
    const err = validateArchive(chosen);
    if (err) {
      toast.error(err);
      return;
    }

    // Deferred mode: just hand the File to the parent - the create wizard streams
    // it after the app exists (there's nothing to upload to yet).
    if (deferred) {
      setPicked(chosen);
      onSelect!(chosen);
      return;
    }

    setProgress(0);
    uploadArchive(appId!, chosen, setProgress)
      .then(() => {
        setProgress(null);
        // Archive stored, not deployed - refresh so it shows as the current
        // upload and the form's "Save & Deploy" button enables.
        toast.success("Archive saved - click Save & Deploy to deploy it");
        router.refresh();
      })
      .catch((e: unknown) => {
        setProgress(null);
        toast.error(e instanceof Error ? e.message : "Upload failed");
      });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handle(file);
  }

  // What to show in the "current archive" chip: the just-picked File in deferred
  // mode, otherwise the archive already stored on the app.
  const shown = deferred
    ? selected
      ? { filename: selected.name, size: selected.size, uploadedAt: null }
      : null
    : current
      ? { ...current, uploadedAt: current.uploadedAt as string | null }
      : null;

  return (
    <div className="space-y-3">
      {shown && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <FileArchive className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{shown.filename}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatBytes(shown.size)}
              {shown.uploadedAt
                ? ` · uploaded ${timeAgo(shown.uploadedAt)}`
                : " · ready to deploy"}
            </p>
          </div>
          <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
        </div>
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={pick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-border p-6 text-center transition-colors",
          dragging && "border-primary bg-primary/5",
          uploading && "cursor-default opacity-80",
        )}
      >
        {uploading ? (
          <>
            <Loader2 className="mb-2 size-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Uploading… {progress}%
            </p>
            <div className="mt-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-150"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <Upload className="mb-2 size-6 text-muted-foreground" />
            <p className="text-sm font-medium">
              {shown
                ? "Replace with a new archive"
                : "Drop an archive or click to browse"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              .tar.gz, .tgz, .tar or .zip · up to{" "}
              {formatBytes(MAX_UPLOAD_BYTES)}
            </p>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {deferred
          ? "The archive is extracted and built with the Build & Output settings below when you deploy."
          : "The archive is extracted and built with the Build & Output settings below. Use Save & Deploy to build and release it."}
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handle(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
