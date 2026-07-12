"use client";

import * as React from "react";
import { Plug, PlugZap, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseAnsi } from "@/lib/ansi";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "ended" | "error";

/**
 * Interactive `docker attach` to a running container's PID 1.
 *
 * Output streams over an EventSource (SSE) from GET /api/apps/:id/attach;
 * the first `session` event carries the server-side session id. Keystrokes are
 * POSTed to the same session so they reach the container's stdin — full-duplex
 * without a WebSocket. Detaching kills only our local attach client, never the
 * container (the route spawns with --sig-proxy=false).
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
  const [output, setOutput] = React.useState("");
  const [value, setValue] = React.useState("");
  const sessionId = React.useRef<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  // Bumped on reconnect to retrigger the effect for a fresh stream.
  const [attempt, setAttempt] = React.useState(0);

  const base = `/api/apps/${encodeURIComponent(appId)}/attach`;

  React.useEffect(() => {
    const url = `${base}?container=${encodeURIComponent(containerName)}`;
    const es = new EventSource(url);

    // Custom `session` frame carries the server-side session id. (Not "open" —
    // that name collides with EventSource's reserved connection-open event,
    // whose data is undefined.)
    es.addEventListener("session", (e) => {
      sessionId.current = JSON.parse((e as MessageEvent).data);
      setStatus("live");
    });
    es.addEventListener("data", (e) => {
      setOutput((prev) => prev + JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("exit", () => {
      setStatus("ended");
      es.close();
    });
    // Native EventSource error: the connection dropped or failed to open.
    es.onerror = () => {
      // If we never went live (no `session` frame), the attach failed
      // (stopped/404). Once live, an error means the stream ended — treat it as
      // such rather than retrying.
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
  }, [base, containerName, attempt]);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Container output carries ANSI color/control codes; render them as styled
  // runs instead of leaking raw `[33m`-style escapes into the pane.
  const segments = React.useMemo(() => parseAnsi(output), [output]);

  async function send(data: string) {
    const id = sessionId.current;
    if (!id || status !== "live") return;
    await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, data }),
    }).catch(() => {});
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status !== "live") return;
    // Line-mode: send the typed line plus a newline. Do NOT echo locally — the
    // attached process echoes its own stdin back through the stream (like a real
    // `docker attach`), so a local echo would double every line.
    void send(value + "\n");
    setValue("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // Ctrl-C: send the literal interrupt byte. Only meaningful with a TTY (the
    // app receives SIGINT); harmless otherwise. No local echo — see submit().
    if (e.key === "c" && e.ctrlKey) {
      e.preventDefault();
      void send("\x03");
    }
  }

  function reconnect() {
    setOutput("");
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

      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className="h-[420px] cursor-text overflow-y-auto bg-black/90 p-3 font-mono text-[13px] leading-relaxed text-zinc-200"
      >
        <pre className="whitespace-pre-wrap break-words text-zinc-300">
          {segments.map((s, i) =>
            s.className ? (
              <span key={i} className={s.className}>
                {s.text}
              </span>
            ) : (
              s.text
            ),
          )}
        </pre>

        {status === "live" && openStdin ? (
          <form onSubmit={submit} className="mt-1 flex items-center gap-2">
            <span className="shrink-0 text-[var(--success)]">›</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className="flex-1 border-0 bg-transparent font-mono text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600"
              aria-label="Send to container stdin"
              placeholder={
                tty
                  ? "type to send to stdin · Ctrl-C to interrupt"
                  : "type to send a line to stdin"
              }
            />
          </form>
        ) : null}

        {status === "live" && !openStdin ? (
          <p className="mt-2 text-[11px] text-zinc-500">
            This container was started without stdin open, so it won&apos;t read
            input — attach is streaming its live output only. Use the exec
            console to run commands.
          </p>
        ) : null}

        {status === "ended" || status === "error" ? (
          <Button
            size="sm"
            variant="outline"
            onClick={reconnect}
            className="mt-3"
          >
            <RotateCcw className="size-4" />
            Reattach
          </Button>
        ) : null}
      </div>
    </div>
  );
}
