"use client";

import * as React from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { XtermView, type XtermApi } from "@/components/apps/xterm-lazy";
import type { ConsoleControls } from "@/components/console/console-controls";

// AttachStatus tracks where the attach stream is.
export type AttachStatus = "connecting" | "live" | "ended" | "error";

// ContainerAttach attaches to a running container PID 1; detaching never kills it (--sig-proxy=false).
export function ContainerAttach({
  appId,
  containerName,
  openStdin,
  apiBase,
  onStatus,
  onControls,
}: {
  appId: string;
  containerName: string;
  openStdin: boolean;
  apiBase?: string;
  onStatus?: (status: AttachStatus) => void;
  onControls?: (controls: ConsoleControls) => void;
}) {
  const [status, setStatus] = React.useState<AttachStatus>("connecting");
  const [ready, setReady] = React.useState(false);
  const term = React.useRef<XtermApi | null>(null);
  const size = React.useRef({ cols: 80, rows: 24 });
  const sessionId = React.useRef<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  const base = apiBase ?? `/api/apps/${encodeURIComponent(appId)}/attach`;

  const post = React.useCallback(
    (
      payload: { data: string } | { resize: { cols: number; rows: number } },
    ) => {
      const id = sessionId.current;
      if (!id) return;
      void fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, ...payload }),
      }).catch(() => {});
    },
    [base],
  );

  React.useEffect(() => {
    if (!ready) return;
    const { cols, rows } = size.current;
    const url = `${base}?container=${encodeURIComponent(
      containerName,
    )}&cols=${cols}&rows=${rows}`;
    const es = new EventSource(url);

    // Not "open": that name collides with the reserved EventSource event.
    es.addEventListener("session", (e) => {
      sessionId.current = JSON.parse((e as MessageEvent).data);
      setStatus("live");
      term.current?.focus();
    });
    es.addEventListener("data", (e) => {
      term.current?.write(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("exit", () => {
      setStatus("ended");
      es.close();
    });
    es.onerror = () => {
      setStatus((s) => (s === "live" ? "ended" : "error"));
      es.close();
    };

    return () => {
      es.close();
      const id = sessionId.current;
      if (id) {
        const delUrl = `${base}?sessionId=${encodeURIComponent(id)}`;
        const beaconed = navigator.sendBeacon?.(delUrl);
        if (!beaconed) {
          fetch(delUrl, { method: "DELETE", keepalive: true }).catch(() => {});
        }
      }
      sessionId.current = null;
    };
  }, [ready, base, containerName, attempt]);

  const onStatusRef = React.useRef(onStatus);
  const onControlsRef = React.useRef(onControls);
  React.useEffect(() => {
    onStatusRef.current = onStatus;
    onControlsRef.current = onControls;
  });

  React.useEffect(() => {
    onStatusRef.current?.(status);
  }, [status]);

  const onReady = React.useCallback((api: XtermApi) => {
    term.current = api;
    size.current = api.fit();
    setReady(true);
    onControlsRef.current?.({
      clear: () => api.reset(),
      text: () => api.getText(),
    });
  }, []);

  const onData = React.useCallback(
    (d: string) => {
      if (openStdin) post({ data: d });
    },
    [openStdin, post],
  );

  const onResize = React.useCallback(
    (cols: number, rows: number) => {
      size.current = { cols, rows };
      post({ resize: { cols, rows } });
    },
    [post],
  );

  function reattach() {
    term.current?.reset();
    sessionId.current = null;
    setStatus("connecting");
    setAttempt((n) => n + 1);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status === "live" && !openStdin ? (
        <div className="flex items-center gap-2 border-b border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2">
          <TriangleAlert className="size-4 shrink-0 text-[var(--warning)]" />
          <p className="text-xs">
            This container was started without stdin open, so it won&apos;t read
            input - attach is streaming its live output only. Use the shell to
            run commands.
          </p>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 bg-terminal p-2">
        <XtermView
          readOnly={!openStdin}
          onReady={onReady}
          onData={onData}
          onResize={onResize}
          className="h-full w-full"
        />
      </div>

      {status === "ended" || status === "error" ? (
        <div className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {status === "error"
              ? "Couldn't attach to this container."
              : "Detached from the container."}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={reattach}
            className="ml-auto"
          >
            <RotateCcw className="size-4" />
            Reattach
          </Button>
        </div>
      ) : null}
    </div>
  );
}
