import {
  isServerDisconnected,
  reportServerUnreachable,
  ServerUnreachableError,
} from "@/lib/server-connection";

// RestoreUploadEvent - what the caller is told while the restore runs.
export interface RestoreUploadEvent {
  percent?: number;
  line?: string;
}

// uploadRestore - stream `file` at a target and follow the restore to its end.
export function uploadRestore(
  target: { kind: "app" | "database"; id: string },
  file: File,
  recoveryKey: string,
  onEvent: (event: RestoreUploadEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isServerDisconnected()) {
      reject(new ServerUnreachableError());
      return;
    }

    const param = target.kind === "app" ? "app" : "database";
    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/backups/restore-upload?${param}=${encodeURIComponent(target.id)}`,
    );
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    if (recoveryKey.trim())
      xhr.setRequestHeader("X-Recovery-Key", recoveryKey.trim());

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onEvent({ percent: Math.round((e.loaded / e.total) * 100) });
    };

    let consumed = 0;
    let verdict: { ok: boolean; error?: string } | null = null;
    const drain = () => {
      const text = xhr.responseText;
      for (;;) {
        const end = text.indexOf("\n", consumed);
        if (end === -1) return;
        const raw = text.slice(consumed, end);
        consumed = end + 1;
        if (!raw.trim()) continue;
        try {
          const message = JSON.parse(raw) as {
            ok?: boolean;
            error?: string;
            text?: string;
          };
          if (typeof message.ok === "boolean")
            verdict = { ok: message.ok, error: message.error };
          else if (message.text) onEvent({ line: message.text });
        } catch {
          // Not our stream (a proxy's error page); onload sorts it out.
        }
      }
    };
    xhr.onprogress = drain;

    xhr.onload = () => {
      drain();
      if (xhr.status >= 200 && xhr.status < 300) {
        if (verdict?.ok) {
          resolve();
          return;
        }
        reject(
          new Error(
            verdict?.error ||
              "The connection dropped before the restore reported its result. " +
                "Check the app's status before trying again.",
          ),
        );
        return;
      }
      try {
        const message = (JSON.parse(xhr.responseText) as { error?: string })
          ?.error;
        if (message) {
          reject(new Error(message));
          return;
        }
      } catch {
        /* not JSON - handled below */
      }
      if (xhr.status >= 500 || xhr.status === 0) {
        reportServerUnreachable();
        reject(new ServerUnreachableError());
        return;
      }
      reject(new Error("Restore failed"));
    };

    xhr.onerror = () => {
      reportServerUnreachable();
      reject(new ServerUnreachableError());
    };

    xhr.send(file);
  });
}
