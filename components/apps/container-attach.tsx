"use client";

import * as React from "react";
import { Plug, PlugZap, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { XtermView, type XtermApi } from "@/components/apps/xterm-lazy";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "ended" | "error";

/**
 * Interactive `docker attach` to a running container's PID 1, rendered in a real
 * xterm.js terminal.
 *
 * Output streams over an EventSource (SSE) from GET /api/apps/:id/attach; the
 * first `session` event carries the server-side session id. Every keystroke —
 * arrows, Tab, Ctrl-C, the lot — is POSTed raw to that session's stdin, so a
 * shell/TUI behaves as it would over a local `docker attach`. The terminal seeds
 * the pty with its own size on open and POSTs a resize on every refit. Detaching
 * kills only our local attach client, never the container (spawn is
 * `--sig-proxy=false`).
 */
export function ContainerAttach({
  appId,
  containerName,
  openStdin,
  tty,
  embedded = false,
}: {
  appId: string;
  containerName: string;
  openStdin: boolean;
  tty: boolean;
  /** Drop the outer border/rounding when nested inside the console chrome. */
  embedded?: boolean;
}) {
  const [status, setStatus] = React.useState<Status>("connecting");
  // Gate the stream on the terminal being mounted + fitted, so the GET can carry
  // the real initial pty size instead of a guess.
  const [ready, setReady] = React.useState(false);
  const term = React.useRef<XtermApi | null>(null);
  const size = React.useRef({ cols: 80, rows: 24 });
  const sessionId = React.useRef<string | null>(null);
  // Bumped on reattach to retrigger the stream effect with a fresh connection.
  const [attempt, setAttempt] = React.useState(0);

  const base = `/api/apps/${encodeURIComponent(appId)}/attach`;

  // One POST helper for both stdin bytes and resize frames — same session route.
  const post = React.useCallback(
    (payload: { data: string } | { resize: { cols: number; rows: number } }) => {
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

    // Custom `session` frame carries the server-side session id. (Not "open" —
    // that name collides with EventSource's reserved connection-open event,
    // whose data is undefined.)
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
    // Native EventSource error: the connection dropped or failed to open. If we
    // never went live (no `session` frame), the attach failed (stopped/404);
    // once live, an error just means the stream ended.
    es.onerror = () => {
      setStatus((s) => (s === "live" ? "ended" : "error"));
      es.close();
    };

    return () => {
      es.close();
      // Best-effort detach so the server reaps the docker attach child promptly
      // instead of waiting for the idle timeout. sendBeacon survives unload;
      // fall back to a keepalive DELETE when it's unavailable.
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

  const onReady = React.useCallback((api: XtermApi) => {
    term.current = api;
    size.current = api.fit();
    setReady(true);
  }, []);

  // Every keystroke (incl. control sequences) → the container's stdin, raw.
  const onData = React.useCallback(
    (d: string) => {
      if (openStdin) post({ data: d });
    },
    [openStdin, post],
  );

  // Refit → reseed the pty so the shell/TUI wraps at the real width.
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

  const statusLabel: Record<Status, string> = {
    connecting: "connecting…",
    live: "attached",
    ended: "detached",
    error: "attach failed",
  };

  return (
    <div
      className={cn(
        "overflow-hidden",
        !embedded && "rounded-xl border border-border",
      )}
    >
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        {status === "live" ? (
          <PlugZap className="size-4 text-[var(--success)]" />
        ) : (
          <Plug className="size-4 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{containerName}</span>
        <span
          className={cn(
            "flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]",
            status === "live"
              ? "text-[var(--success)]"
              : status === "error"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              status === "live"
                ? "animate-pulse bg-[var(--success)]"
                : status === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
          />
          {statusLabel[status]}
        </span>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {tty ? "tty" : openStdin ? "stdin" : "output-only"} · attach (PID 1)
        </span>
      </div>

      <div className="h-[420px] bg-[#0a0a0a] p-2">
        <XtermView
          readOnly={!openStdin}
          onReady={onReady}
          onData={onData}
          onResize={onResize}
          className="h-full w-full"
        />
      </div>

      {status === "live" && !openStdin ? (
        <div className="border-t border-border bg-secondary/20 px-3 py-2 text-[11px] text-muted-foreground">
          This container was started without stdin open, so it won&apos;t read
          input — attach is streaming its live output only. Use the exec console
          to run commands.
        </div>
      ) : null}

      {status === "ended" || status === "error" ? (
        <div className="flex items-center gap-2 border-t border-border bg-secondary/20 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {status === "error"
              ? "Couldn't attach to this container."
              : "Detached from the container."}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={reattach}
            className="ml-auto h-7"
          >
            <RotateCcw className="size-4" />
            Reattach
          </Button>
        </div>
      ) : null}
    </div>
  );
}
