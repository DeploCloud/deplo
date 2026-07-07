"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload, FileArchive, Loader2, CheckCircle2 } from "lucide-react";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import {
  MAX_UPLOAD_BYTES,
  ACCEPT_ATTR,
  ACCEPT_RE,
} from "@/lib/deploy/upload-shared";

export interface CurrentUpload {
  filename: string;
  size: number;
  uploadedAt: string;
}

/**
 * Drag-and-drop / file-picker upload of a code archive for an "upload"-source
 * project. Streams the file to the project's upload route (raw body, filename
 * in a header) with a live progress bar via XHR — `fetch` can't report upload
 * progress. On success the server has already kicked off a deploy; we refresh
 * so the new archive + deployment surface immediately.
 */
export function UploadInput({
  serviceId,
  slug,
  current,
}: {
  serviceId: string;
  slug: string;
  current: CurrentUpload | null;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);

  const uploading = progress !== null;

  function pick() {
    if (!uploading) inputRef.current?.click();
  }

  function upload(file: File) {
    if (!ACCEPT_RE.test(file.name)) {
      toast.error("Unsupported archive — use .tar.gz, .tgz, .tar or .zip");
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error(`Archive too large (max ${formatBytes(MAX_UPLOAD_BYTES)})`);
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/services/${serviceId}/upload`);
    xhr.setRequestHeader("X-Upload-Filename", file.name);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      if (xhr.status >= 200 && xhr.status < 300) {
        toast.success("Upload complete — deploying");
        // Jump to the deployment so the user watches the live build/extract
        // logs; fall back to an in-place refresh if the id is missing.
        let deploymentId: string | undefined;
        try {
          deploymentId = JSON.parse(xhr.responseText)?.deploymentId;
        } catch {
          /* non-JSON success body */
        }
        if (deploymentId) {
          router.push(`/services/${slug}/deployments/${deploymentId}`);
        } else {
          router.refresh();
        }
      } else {
        let msg = "Upload failed";
        try {
          msg = JSON.parse(xhr.responseText)?.error ?? msg;
        } catch {
          /* non-JSON error body */
        }
        toast.error(msg);
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      toast.error("Upload failed");
    };

    setProgress(0);
    xhr.send(file);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (uploading) return;
    const file = e.dataTransfer.files?.[0];
    if (file) upload(file);
  }

  return (
    <div className="space-y-3">
      {current && (
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-3">
          <FileArchive className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{current.filename}</p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(current.size)} · uploaded {timeAgo(current.uploadedAt)}
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
              {current ? "Upload a new build" : "Drop an archive or click to browse"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              .tar.gz, .tgz, .tar or .zip · up to {formatBytes(MAX_UPLOAD_BYTES)}
            </p>
          </>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        The archive is extracted and built with the Build &amp; Output settings
        below, then deployed automatically.
      </p>

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
