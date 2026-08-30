/**
 * Browser side of the restore-from-file route: stream the artifact up, read the
 * agent's log lines back down, resolve on the verdict.
 */

import {
  isServerDisconnected,
  reportServerUnreachable,
  ServerUnreachableError,
} from "@/lib/server-connection";

/** What the caller is told while the restore runs. */
export interface RestoreUploadEvent {
  /** 0-100 while the artifact is going up. */
  percent?: number;
  /** One line the agent logged, as it logged it. */
  line?: string;
}

/**
 * Stream `file` at a target and follow the restore to its end. `recoveryKey` is
 * sent only when the file is encrypted - the caller decides, having read the
 * file's first bytes.
 */
export function uploadRestore(
  target: { kind: "app" | "database"; id: string },
  file: File,
  recoveryKey: string,
  onEvent: (event: RestoreUploadEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Offline: refuse before streaming an artifact at a server that isn't there,
    // and say the same thing every other paused interaction says.
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

    // The response is NDJSON that arrives while the restore runs, so it is read
    // incrementally: everything up to the last newline seen is already complete.
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
          // A half-written line cannot happen (we cut on newlines), so this is a
          // proxy's error page rather than our stream. onload sorts it out.
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
        // A 200 whose stream ended without a verdict is a connection cut between
        // here and the control plane; the restore may well still be running.
        reject(
          new Error(
            verdict?.error ||
              "The connection dropped before the restore reported its result. " +
                "Check the app's status before trying again.",
          ),
        );
        return;
      }
      // A refusal never streams: it is one JSON object with the message.
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

    // A transport-level failure is the server being gone, not a bad artifact.
    xhr.onerror = () => {
      reportServerUnreachable();
      reject(new ServerUnreachableError());
    };

    xhr.send(file);
  });
}
