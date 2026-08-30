// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side helpers for streaming a code archive to an app's upload route.
 */

import { formatBytes } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, ACCEPT_RE } from "@/lib/deploy/upload-shared";
import {
  isServerDisconnected,
  reportServerUnreachable,
  ServerUnreachableError,
} from "@/lib/server-connection";

/**
 * Reject an archive the server would refuse anyway - an unsupported extension or
 * one past the size cap. Returns a user-facing message, or null when the file is
 * acceptable. Mirrors the server-side guards so the failure surfaces instantly.
 */
export function validateArchive(file: File): string | null {
  if (!ACCEPT_RE.test(file.name)) {
    return "Unsupported archive - use .tar.gz, .tgz, .tar or .zip";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Archive too large (max ${formatBytes(MAX_UPLOAD_BYTES)})`;
  }
  return null;
}

/**
 * Stream `file` to an app's upload route as a raw body (filename in a header),
 * reporting progress via `onProgress` (0-100). Uses XHR rather than `fetch`
 * because only XHR reports upload progress.
 */
export function uploadArchive(
  appId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Offline: refuse before streaming megabytes at a server that isn't there,
    // and say the same thing every other paused interaction says.
    if (isServerDisconnected()) {
      reject(new ServerUnreachableError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/apps/${appId}/upload`);
    xhr.setRequestHeader("X-Upload-Filename", file.name);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        try {
          const msg = JSON.parse(xhr.responseText)?.error;
          if (msg) {
            reject(new Error(msg));
            return;
          }
        } catch {
          /* not JSON - handled below */
        }
        // The route always answers JSON, so a body we can't parse (a proxy's
        // HTML error page) or a gateway status means we never reached it.
        if (xhr.status >= 500 || xhr.status === 0) {
          reportServerUnreachable();
          reject(new ServerUnreachableError());
          return;
        }
        reject(new Error("Upload failed"));
      }
    };
    // A transport-level failure is the server being gone, not a bad archive.
    xhr.onerror = () => {
      reportServerUnreachable();
      reject(new ServerUnreachableError());
    };
    xhr.send(file);
  });
}
