"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { FileArchive, Loader2, CheckCircle2 } from "lucide-react";
import { UploadGraphic } from "@/components/apps/upload-graphic";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, ACCEPT_ATTR } from "@/lib/deploy/upload-shared";
import { validateArchive, uploadArchive } from "@/lib/deploy/upload-client";

export interface CurrentUpload {
  filename: string;
  size: number;
  uploadedAt: string;
}

// UploadInput - drag-and-drop upload of a code archive for an upload-source app.
export function UploadInput({
  appId,
  current,
  onSelect,
  file,
}: {
  appId?: string;
  current?: CurrentUpload | null;
  onSelect?: (file: File | null) => void;
  file?: File | null;
}) {
  const router = useRouter();
  const deferred = typeof onSelect === "function";
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
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

    if (deferred) {
      setPicked(chosen);
      onSelect!(chosen);
      return;
    }

    setProgress(0);
    uploadArchive(appId!, chosen, setProgress)
      .then(() => {
        setProgress(null);
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
        <div className="flex items-center gap-3 rounded-md border border-border bg-surface p-3">
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
        data-active={dragging || undefined}
        className={cn(
          "group flex min-h-72 cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-border p-8 text-center transition-colors",
          dragging && "border-primary bg-primary-wash",
          uploading && "cursor-default opacity-80",
        )}
      >
        {uploading ? (
          <>
            <Loader2 className="mb-3 size-7 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Uploading {progress}%
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
            <UploadGraphic className="mb-3" />
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
