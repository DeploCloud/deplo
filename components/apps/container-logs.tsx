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
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import type { AppRuntimeView } from "@/components/apps/use-app-runtime";
import type { ConsoleInstance } from "@/lib/data/console";
import { stripAnsi } from "@/lib/ansi";
import { mergeLogBurst } from "@/lib/logs/merge";
import { detectLogLevel } from "@/lib/log-level-detect";
import { LEVEL_BADGE_CLASS, LEVEL_LABEL } from "@/lib/log-levels";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "reattaching" | "ended" | "error";

/** The curated reasons the log route can refuse a stream (lib/infra/agent-client.ts). */
const FAILURE_TEXT: Record<string, string> = {
  unreachable: "The server agent is unreachable — the host may be down.",
  "not-found": "That container no longer exists on the host.",
  denied: "That container does not belong to this app.",
  failed: "The log stream failed.",
};

/** Reattach backoff after the container dies, capped so a crash loop settles into
 *  a steady poll rather than hammering the agent. */
const REATTACH_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
/** Give up auto-reattaching eventually — a tab left open for days on a container
 *  that will never come back should not keep dialling forever. */
const MAX_REATTACHES = 60;
/** After a reattach, `docker logs --tail` replays lines we already show. Treat
 *  output arriving in this window as that replay and merge it; later output is
 *  live and appended straight. */
const REPLAY_WINDOW_MS = 3_000;

/**
 * Live runtime logs (`docker logs -f`) for an app's container.
 *
 * Output streams over an EventSource (SSE) from GET /api/apps/:id/logs; the first
 * `session` event carries the server-side session id, used on unload to detach
 * promptly. Closing the viewer kills only our local `docker logs` client, never
 * the container.
 *
 * The container does NOT have to be running. `docker logs` reads the container's
 * log file, which outlives the process, so a stopped container still shows its
 * final words — and a crash-looping one is followed ACROSS its restarts: docker
 * ends the follow every time the process dies, so we reattach, and merge the
 * replayed tail into what is already on screen instead of duplicating it.
 */
export function ContainerLogs({
  appId,
  instances,
  runtime,
}: {
  appId: string;
  instances: ConsoleInstance[];
  runtime?: AppRuntimeView | null;
}) {
  // Active instance — default to the server-preferred first entry (the app's own
  // container, even when a sidecar is the only healthy one in the stack).
  const [active, setActive] = React.useState<ConsoleInstance>(
    () => instances[0],
  );
  const [status, setStatus] = React.useState<Status>("connecting");
  const [failure, setFailure] = React.useState<string | null>(null);
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

  // Text already shown, plus the replay-merge state for a reattach.
  const outputRef = React.useRef("");
  const replayBaseRef = React.useRef<string | null>(null);
  const replayBurstRef = React.useRef("");
  const replayUntilRef = React.useRef(0);
  // Consecutive auto-reattaches; reset by any manual action or new output.
  const reattachCount = React.useRef(0);

  // The container we are streaming, as the host has it right now — so the stream
  // knows whether an ended follow means "it crashed and will be back" or "it is
  // gone". Read from the runtime poll, which is the only live source of that.
  const liveState = runtime?.containers.find((c) => c.name === active.name);
  const comingBack =
    !!runtime &&
    !runtime.unreachable &&
    (liveState?.state === "restarting" ||
      runtime.restarting > 0 ||
      !!liveState?.running);
  // Mirrored into a ref so the stream effect can read the CURRENT answer when a
  // follow ends, without listing it as a dependency — re-running the effect on
  // every runtime poll would tear the stream down and rebuild it every 5s.
  const comingBackRef = React.useRef(comingBack);
  React.useEffect(() => {
    comingBackRef.current = comingBack;
  }, [comingBack]);

  const base = `/api/apps/${encodeURIComponent(appId)}/logs`;

  React.useEffect(() => {
    const url = `${base}?container=${encodeURIComponent(active.name)}`;
    const es = new EventSource(url);
    let reattachTimer: ReturnType<typeof setTimeout> | undefined;

    // Everything already on screen is the baseline the replayed tail is merged
    // against. On a first attach there is nothing to merge, so skip it.
    if (outputRef.current) {
      replayBaseRef.current = outputRef.current;
      replayBurstRef.current = "";
      replayUntilRef.current = Date.now() + REPLAY_WINDOW_MS;
    }

    const appendChunk = (text: string) => {
      const replaying =
        replayBaseRef.current !== null && Date.now() < replayUntilRef.current;
      if (replaying) {
        // Re-merge from the baseline on every chunk: idempotent, so a tail that
        // arrives split across chunks converges on the same result as one burst.
        replayBurstRef.current += text;
        outputRef.current = mergeLogBurst(
          replayBaseRef.current!,
          replayBurstRef.current,
        );
      } else {
        replayBaseRef.current = null;
        replayBurstRef.current = "";
        outputRef.current += text;
      }
      setOutput(outputRef.current);
    };

    es.addEventListener("session", (e) => {
      sessionId.current = JSON.parse((e as MessageEvent).data);
      setStatus("live");
      setFailure(null);
    });
    es.addEventListener("data", (e) => {
      appendChunk(JSON.parse((e as MessageEvent).data) as string);
    });

    // The stream refused to open, or died on a real failure — say so instead of
    // leaving an empty pane. A permanent refusal (no such container, not ours)
    // must not be retried; an unreachable host may recover, but the user asks.
    es.addEventListener("failure", (e) => {
      const reason = JSON.parse((e as MessageEvent).data) as string;
      setFailure(FAILURE_TEXT[reason] ?? FAILURE_TEXT.failed);
      setStatus("error");
      es.close();
    });

    // `docker logs -f` ends every time the container dies. For a container docker
    // is restarting, that is not the end of the story — it is one turn of the
    // loop, so reattach (with backoff) and keep the output flowing across it.
    es.addEventListener("exit", () => {
      es.close();
      if (comingBackRef.current && reattachCount.current < MAX_REATTACHES) {
        const wait =
          REATTACH_MS[Math.min(reattachCount.current, REATTACH_MS.length - 1)];
        reattachCount.current += 1;
        setStatus("reattaching");
        reattachTimer = setTimeout(() => setAttempt((n) => n + 1), wait);
        return;
      }
      setStatus("ended");
    });

    es.onerror = () => {
      // No `session` frame yet ⇒ the stream failed to open. Once live, an error
      // is the connection dropping — reattach if the container is still there.
      setStatus((s) => {
        if (s !== "live") return "error";
        if (comingBackRef.current && reattachCount.current < MAX_REATTACHES) {
          reattachCount.current += 1;
          reattachTimer = setTimeout(() => setAttempt((n) => n + 1), 2_000);
          return "reattaching";
        }
        return "ended";
      });
      es.close();
    };

    return () => {
      clearTimeout(reattachTimer);
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

  function resetStream() {
    setOutput("");
    outputRef.current = "";
    replayBaseRef.current = null;
    replayBurstRef.current = "";
    reattachCount.current = 0;
    sessionId.current = null;
    setFailure(null);
    setStatus("connecting");
    setFollow(true);
  }

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (!next || next.name === active.name) return;
    resetStream();
    setActive(next);
    setAttempt((n) => n + 1);
  }

  function reconnect() {
    resetStream();
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
    reattaching: "container restarted — reattaching…",
    ended: "ended",
    error: "failed",
  };
  const busy = status === "connecting" || status === "reattaching";

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
              {instances.map((inst) => {
                const state = runtime?.containers.find(
                  (c) => c.name === inst.name,
                );
                const restarting = state?.state === "restarting";
                const up = state ? state.running : inst.running;
                return (
                  <SelectItem
                    key={inst.name}
                    value={inst.name}
                    className="font-mono text-xs"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          restarting
                            ? "animate-pulse bg-[var(--warning)]"
                            : up
                              ? "bg-[var(--success)]"
                              : "bg-destructive",
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
                );
              })}
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
                : status === "reattaching"
                  ? "text-[var(--warning)]"
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
                  : status === "reattaching"
                    ? "animate-pulse bg-[var(--warning)]"
                    : "bg-muted-foreground/50",
            )}
          />
          {statusLabel[status]}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Badge variant="muted" className="font-mono text-[10px]">
            {follow ? "following" : "paused"}
          </Badge>
          <SimpleTooltip
            content={follow ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (follow ? setFollow(false) : resumeFollow())}
              className="h-7 gap-1.5 px-2 text-xs"
            >
              {follow ? (
                <Pause className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="Clear">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOutput("");
                outputRef.current = "";
              }}
              className="h-7 gap-1.5 px-2 text-xs"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </SimpleTooltip>
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

        {status === "reattaching" ? (
          <p className="mt-1 text-[11px] text-[var(--warning)]">
            The container exited — waiting for docker to restart it, then
            picking the stream back up.
          </p>
        ) : null}

        {(status === "live" || busy) && output === "" && !failure ? (
          <p className="mt-1 text-[11px] text-zinc-500">
            No output yet — new log lines will appear here as the container emits
            them.
          </p>
        ) : null}

        {failure ? (
          <p className="mt-1 text-[11px] text-destructive">{failure}</p>
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
