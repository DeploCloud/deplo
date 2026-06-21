"use client";

import * as React from "react";
import {
  ScrollText,
  Boxes,
  RotateCcw,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import type { ConsoleInstance } from "@/lib/data/console";
import { stripAnsi } from "@/lib/ansi";
import { detectLogLevel } from "@/lib/log-level-detect";
import { LEVEL_BADGE_CLASS, LEVEL_LABEL } from "@/lib/log-levels";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "ended" | "error";

/**
 * Live runtime logs (`docker logs -f`) for a project's container.
 *
 * Output streams over an EventSource (SSE) from GET /api/projects/:id/logs; the
 * first `session` event carries the server-side session id, used on unload to
 * detach promptly (the same session/SSE plumbing as the attach console, minus
 * the stdin direction — logs are read-only). Closing the viewer kills only our
 * local `docker logs` client, never the container.
 */
export function ContainerLogs({
  projectId,
  instances,
}: {
  projectId: string;
  instances: ConsoleInstance[];
}) {
  // Active instance — default to the server-preferred first entry (exposed/
  // running). Switching reopens the stream against another container in the stack.
  const [active, setActive] = React.useState<ConsoleInstance>(
    () => instances[0],
  );
  const [status, setStatus] = React.useState<Status>("connecting");
  const [output, setOutput] = React.useState("");
  // Auto-follow keeps the view pinned to the newest line. Turned off when the
  // user scrolls up, back on when they scroll to the bottom (or hit Resume).
  const [follow, setFollow] = React.useState(true);
  const sessionId = React.useRef<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // True while WE are setting scrollTop (auto-follow). The browser fires `scroll`
  // for programmatic scrolls too, so without this flag the tail burst's own
  // scroll-to-bottom could be misread as a user scrolling away and flip follow
  // off — leaving the view parked above the newest line.
  const programmaticScroll = React.useRef(false);
  // Bumped on reconnect / instance switch to retrigger the stream effect.
  const [attempt, setAttempt] = React.useState(0);

  const base = `/api/projects/${encodeURIComponent(projectId)}/logs`;

  React.useEffect(() => {
    const url = `${base}?container=${encodeURIComponent(active.name)}`;
    const es = new EventSource(url);

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
    es.onerror = () => {
      // No `session` frame yet ⇒ the stream failed to open (404/409). Once live,
      // an error means the stream ended — treat it as such rather than retrying.
      setStatus((s) => (s === "live" ? "ended" : "error"));
      es.close();
    };

    return () => {
      es.close();
      // Best-effort detach so the server reaps the `docker logs` child promptly
      // instead of waiting for the idle timeout. sendBeacon survives unload.
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
  }, [base, active.name, attempt]);

  // Pin to the bottom on new output while following. Flag the scroll as
  // programmatic so onScroll doesn't mistake it for the user scrolling away.
  React.useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, [output, follow]);

  // Container logs arrive as a raw byte stream with no severity (Docker keeps
  // none), so we split the buffer into lines, strip ANSI to get the plain text,
  // and infer a level per line — letting the runtime pane render the same level
  // pills/tints as the build-log stream. A trailing partial line (no newline
  // yet) is still shown; it just reclassifies as more bytes arrive.
  const lines = React.useMemo(() => {
    const stripped = stripAnsi(output);
    if (!stripped) return [];
    // Keep a trailing empty entry out (split on "\n" yields one after a final
    // newline); blank interior lines are preserved so spacing survives.
    const raw = stripped.split("\n");
    if (raw[raw.length - 1] === "") raw.pop();
    return raw.map((text) => ({ level: detectLogLevel(text), text }));
  }, [output]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // Ignore the scroll event our own auto-follow effect just triggered — only a
    // genuine user scroll should toggle following.
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    // Within ~24px of the bottom counts as "at the bottom" → keep following.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (!next || next.name === active.name) return;
    setOutput("");
    sessionId.current = null;
    setStatus("connecting");
    setFollow(true);
    setActive(next);
    setAttempt((n) => n + 1);
  }

  function reconnect() {
    setOutput("");
    sessionId.current = null;
    setStatus("connecting");
    setFollow(true);
    setAttempt((n) => n + 1);
  }

  function resumeFollow() {
    setFollow(true);
    const el = scrollRef.current;
    if (el) {
      programmaticScroll.current = true;
      el.scrollTop = el.scrollHeight;
    }
  }

  const statusLabel: Record<Status, string> = {
    connecting: "connecting…",
    live: "streaming",
    ended: "ended",
    error: "failed",
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <ScrollText className="size-4 text-muted-foreground" />
        {instances.length > 1 ? (
          <Select value={active.name} onValueChange={switchInstance}>
            <SelectTrigger className="h-7 w-auto gap-2 border-border/60 bg-background/60 px-2 font-mono text-xs">
              <Boxes className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {instances.map((inst) => (
                <SelectItem
                  key={inst.name}
                  value={inst.name}
                  className="font-mono text-xs"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        inst.running
                          ? "bg-[var(--success)]"
                          : "bg-muted-foreground/50",
                      )}
                    />
                    {inst.service}
                    {inst.exposed ? (
                      <span className="text-[10px] text-muted-foreground">
                        app
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="font-mono text-xs">{active.name}</span>
        )}
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

        <div className="ml-auto flex items-center gap-1">
          <Badge variant="muted" className="font-mono text-[10px]">
            {follow ? "following" : "paused"}
          </Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => (follow ? setFollow(false) : resumeFollow())}
            className="h-7 gap-1.5 px-2 text-xs"
            title={follow ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            {follow ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOutput("")}
            className="h-7 gap-1.5 px-2 text-xs"
            title="Clear"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <CopyButton value={output} className="size-7" />
          <DownloadButton
            value={output}
            filename={`${active.name}.log`}
            className="size-7"
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-[520px] overflow-y-auto bg-black/90 p-3 font-mono text-[13px] leading-relaxed text-zinc-200"
      >
        {lines.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span
              className={cn(
                "shrink-0 select-none rounded px-1.5 text-[10px] font-semibold uppercase leading-5 tracking-wide",
                LEVEL_BADGE_CLASS[l.level] ?? "bg-zinc-700/30 text-zinc-300",
              )}
            >
              {LEVEL_LABEL[l.level] ?? l.level}
            </span>
            {/* Message text stays neutral — the level pill carries the colour. */}
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-zinc-300">
              {l.text}
            </span>
          </div>
        ))}

        {status === "connecting" && !output ? (
          <p className="text-[11px] text-zinc-500">Connecting to log stream…</p>
        ) : null}

        {(status === "live" || status === "connecting") && output === "" ? (
          <p className="mt-1 text-[11px] text-zinc-500">
            No output yet — new log lines will appear here as the container emits
            them.
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
            Reconnect
          </Button>
        ) : null}
      </div>
    </div>
  );
}
