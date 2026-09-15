import { formatBytes } from "@/lib/utils";
import { MAX_UPLOAD_BYTES, ACCEPT_RE } from "@/lib/deploy/upload-shared";
import {
  isServerDisconnected,
  reportServerUnreachable,
  ServerUnreachableError,
} from "@/lib/server-connection";

export function validateArchive(file: File): string | null {
  if (!ACCEPT_RE.test(file.name)) {
    return "Unsupported archive - use .tar.gz, .tgz, .tar or .zip";
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return `Archive too large (max ${formatBytes(MAX_UPLOAD_BYTES)})`;
  }
  return null;
}

export function uploadArchive(
  appId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
        } catch {}
        if (xhr.status >= 500 || xhr.status === 0) {
          reportServerUnreachable();
          reject(new ServerUnreachableError());
          return;
        }
        reject(new Error("Upload failed"));
      }
    };
    xhr.onerror = () => {
      reportServerUnreachable();
      reject(new ServerUnreachableError());
    };
    xhr.send(file);
  });
}
