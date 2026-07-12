/**
 * Client-side helpers for streaming a code archive to an app's upload route.
 * Shared by the app settings form (components/apps/upload-input.tsx) and
 * the create-app wizard so validation and the raw-body XHR upload live in one
 * place. Kept free of any Node-only / "server-only" imports so it bundles for the
 * browser — see lib/deploy/upload-shared.ts for the size/extension constants it
 * builds on.
 */

import { formatBytes } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, ACCEPT_RE } from "@/lib/deploy/upload-shared";

/**
 * Reject an archive the server would refuse anyway — an unsupported extension or
 * one past the size cap. Returns a user-facing message, or null when the file is
 * acceptable. Mirrors the server-side guards so the failure surfaces instantly.
 */
export function validateArchive(file: File): string | null {
  if (!ACCEPT_RE.test(file.name)) {
    return "Unsupported archive — use .tar.gz, .tgz, .tar or .zip";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Archive too large (max ${formatBytes(MAX_UPLOAD_BYTES)})`;
  }
  return null;
}

/**
 * Stream `file` to an app's upload route as a raw body (filename in a header),
 * reporting progress via `onProgress` (0–100). Resolves once the archive is
 * stored server-side; the route no longer deploys on upload, so the caller
 * triggers the deploy separately (Save & Deploy / the wizard's Deploy). Uses
 * XHR rather than `fetch` because only XHR reports upload progress.
 */
export function uploadArchive(
  appId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/apps/${appId}/upload`);
    xhr.setRequestHeader("X-Upload-Filename", file.name);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let msg = "Upload failed";
        try {
          msg = JSON.parse(xhr.responseText)?.error ?? msg;
        } catch {
          /* non-JSON error body */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed"));
    xhr.send(file);
  });
}
