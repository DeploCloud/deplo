"use client";

import * as React from "react";
import {
  ScrollText,
  Boxes,
  RotateCcw,
  Pause,
  Play,
  Trash2,
  FileSearch,
  PlugZap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { LogLines, LogRow } from "@/components/shared/log-line-row";
import { LogsDisplayMenu } from "@/components/shared/logs-display";
import {
  LogSearch,
  LogLevelFilter,
  useLogFilters,
  RUNTIME_LEVELS,
} from "@/components/logs/log-filters";
import { LogNoticeChip, type LogNotice } from "@/components/logs/log-notice";
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
import {
  TimelineMenu,
  defaultTimeline,
  formatLogClock,
  type LogTimeline,
} from "@/components/logs/timeline-menu";
import type { AppRuntimeView } from "@/components/apps/use-app-runtime";
import type { ConsoleInstance } from "@/lib/data/console";
import { stripAnsi } from "@/lib/ansi";
import { mergeLogBurst } from "@/lib/logs/merge";
import { splitTimestamp } from "@/lib/logs/window";
import { detectLogLevel, isLogContinuation } from "@/lib/log-level-detect";
import { DEFAULT_LOG_RANGE_DAYS, type LogLevel } from "@/lib/types/deployment";
import { cn } from "@/lib/utils";

type Status = "connecting" | "live" | "reattaching" | "ended" | "error";

const FAILURE_TEXT: Record<string, string> = {
  unreachable: "The server agent is unreachable - the host may be down.",
  "not-found": "That container no longer exists on the host.",
  denied: "That container does not belong to this app.",
  failed: "The log stream failed.",
};

const REATTACH_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_REATTACHES = 60;
const REPLAY_WINDOW_MS = 3_000;
const MAX_BUFFER_CHARS = 512_000;
const MAX_RENDER_LINES = 5_000;
const MAX_DETECT_CHARS = 2_000;

function capBuffer(text: string): string {
  if (text.length <= MAX_BUFFER_CHARS) return text;
  const tail = text.slice(-MAX_BUFFER_CHARS);
  const nl = tail.indexOf("\n");
  return nl === -1 ? tail : tail.slice(nl + 1);
}

function classifyLine(raw: string, prev: LogLevel): ParsedLine {
  const { ts, rest: text } = splitTimestamp(raw);
  const sample =
    text.length > MAX_DETECT_CHARS ? text.slice(0, MAX_DETECT_CHARS) : text;
  const plain = stripAnsi(sample);
  if (prev !== "info" && isLogContinuation(plain))
    return { level: prev, text, ts };
  return { level: detectLogLevel(plain), text, ts };
}

interface ParsedLine {
  level: LogLevel;
  text: string;
  ts: string | null;
}

// ContainerLogs streams runtime logs for one app container over SSE.
export function ContainerLogs({
  appId,
  instances,
  runtime,
  apiBase,
  notice = null,
  title,
  toolbar,
  supportsTimeline = false,
  logMaxDays = DEFAULT_LOG_RANGE_DAYS,
}: {
  appId: string;
  instances: ConsoleInstance[];
  runtime?: AppRuntimeView | null;
  supportsTimeline?: boolean;
  logMaxDays?: number;
  notice?: LogNotice | null;
  title?: PaneTitle;
  toolbar?: React.ReactNode;
  apiBase?: string;
}) {
  const [active, setActive] = React.useState<ConsoleInstance>(
    () => instances[0],
  );
  const [status, setStatus] = React.useState<Status>("connecting");
  const [timeline, setTimeline] = React.useState<LogTimeline>(() =>
    defaultTimeline(logMaxDays),
  );
  const [failure, setFailure] = React.useState<string | null>(null);
  const [output, setOutput] = React.useState("");
  const [lines, setLines] = React.useState<ParsedLine[]>([]);
  const [follow, setFollow] = React.useState(true);
  const sessionId = React.useRef<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const programmaticScroll = React.useRef(false);
  const [attempt, setAttempt] = React.useState(0);

  const outputRef = React.useRef("");
  const replayBaseRef = React.useRef<string | null>(null);
  const replayBurstRef = React.useRef("");
  const replayUntilRef = React.useRef(0);
  const parseRef = React.useRef<{
    text: string;
    parsedTo: number;
    lines: ParsedLine[];
  }>({ text: "", parsedTo: 0, lines: [] });

  const publishLines = React.useCallback(() => {
    const text = outputRef.current;
    if (!text) {
      parseRef.current = { text: "", parsedTo: 0, lines: [] };
      setLines([]);
      return;
    }
    const prev = parseRef.current;
    const appended = prev.text !== "" && text.startsWith(prev.text);
    const acc = appended ? prev.lines : [];
    let from = appended ? prev.parsedTo : 0;
    const lastNl = text.lastIndexOf("\n");
    if (lastNl >= from) {
      let prev: LogLevel = acc.length ? acc[acc.length - 1]!.level : "info";
      for (const line of text.slice(from, lastNl).split("\n")) {
        const classified = classifyLine(line, prev);
        prev = classified.level;
        acc.push(classified);
      }
      from = lastNl + 1;
    }
    if (acc.length > MAX_RENDER_LINES) {
      acc.splice(0, acc.length - MAX_RENDER_LINES);
    }
    parseRef.current = { text, parsedTo: from, lines: acc };
    const partial = text.slice(from);
    const tailLevel: LogLevel = acc.length
      ? acc[acc.length - 1]!.level
      : "info";
    setLines(partial ? [...acc, classifyLine(partial, tailLevel)] : [...acc]);
  }, []);
  const reattachCount = React.useRef(0);

  const liveState = runtime?.containers.find((c) => c.name === active.name);
  const comingBack =
    !!runtime &&
    !runtime.unreachable &&
    (liveState?.state === "restarting" ||
      runtime.restarting > 0 ||
      !!liveState?.running);
  const comingBackRef = React.useRef(comingBack);
  React.useEffect(() => {
    comingBackRef.current = comingBack;
  }, [comingBack]);

  const base = apiBase ?? `/api/apps/${encodeURIComponent(appId)}/logs`;

  const windowKeyRef = React.useRef<string | null>(null);

  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!timeline.timestamps || timeline.format !== "relative") return;
    const t = setInterval(() => setNowMs(Date.now()), 10_000);
    return () => clearInterval(t);
  }, [timeline.timestamps, timeline.format]);

  React.useEffect(() => {
    const windowKey = `${supportsTimeline}:${timeline.sinceMinutes}:${timeline.timestamps}`;

    const previous = windowKeyRef.current;
    windowKeyRef.current = windowKey;
    if (previous !== null && previous !== windowKey) {
      outputRef.current = "";
      setOutput("");
      publishLines();
      replayBaseRef.current = null;
      replayBurstRef.current = "";
    }

    const params = new URLSearchParams({ container: active.name });
    if (supportsTimeline) {
      params.set("sinceMinutes", String(timeline.sinceMinutes));
      if (timeline.timestamps) params.set("timestamps", "1");
    }
    const url = `${base}?${params.toString()}`;
    const es = new EventSource(url);
    let reattachTimer: ReturnType<typeof setTimeout> | undefined;

    if (outputRef.current) {
      replayBaseRef.current = outputRef.current;
      replayBurstRef.current = "";
      replayUntilRef.current = Date.now() + REPLAY_WINDOW_MS;
    }

    const appendChunk = (text: string) => {
      const replaying =
        replayBaseRef.current !== null && Date.now() < replayUntilRef.current;
      if (replaying) {
        replayBurstRef.current += text;
        outputRef.current = mergeLogBurst(
          replayBaseRef.current!,
          replayBurstRef.current,
        );
        if (replayBurstRef.current.length > MAX_BUFFER_CHARS) {
          replayBaseRef.current = null;
          replayBurstRef.current = "";
        }
      } else {
        replayBaseRef.current = null;
        replayBurstRef.current = "";
        outputRef.current += text;
      }
      outputRef.current = capBuffer(outputRef.current);
      setOutput(outputRef.current);
      publishLines();
    };

    es.addEventListener("session", (e) => {
      sessionId.current = JSON.parse((e as MessageEvent).data);
      setStatus("live");
      setFailure(null);
    });
    es.addEventListener("data", (e) => {
      appendChunk(JSON.parse((e as MessageEvent).data) as string);
    });

    es.addEventListener("failure", (e) => {
      const reason = JSON.parse((e as MessageEvent).data) as string;
      setFailure(FAILURE_TEXT[reason] ?? FAILURE_TEXT.failed);
      setStatus("error");
      es.close();
    });

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
  }, [
    base,
    active.name,
    attempt,
    publishLines,
    supportsTimeline,
    timeline.sinceMinutes,
    timeline.timestamps,
  ]);

  React.useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, [output, follow]);

  const filters = useLogFilters(lines, RUNTIME_LEVELS);

  const plainOutput = React.useMemo(
    () =>
      filters.shown
        .map((l) =>
          l.ts && timeline.timestamps
            ? `${l.ts} ${stripAnsi(l.text)}`
            : stripAnsi(l.text),
        )
        .join("\n"),
    [filters.shown, timeline.timestamps],
  );

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }

  function resetStream() {
    setOutput("");
    outputRef.current = "";
    publishLines();
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

  function clear() {
    setOutput("");
    outputRef.current = "";
    publishLines();
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
    connecting: "connecting",
    live: "streaming",
    reattaching: "reattaching",
    ended: "ended",
    error: "failed",
  };
  const busy = status === "connecting" || status === "reattaching";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Controls beside the search input are h-9, not size="sm" (h-8). */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <ScrollText className="size-4 shrink-0 text-muted-foreground" />
        <PaneTitleLink title={title} />
        {toolbar}
        {instances.length > 1 ? (
          <Select value={active.name} onValueChange={switchInstance}>
            <SelectTrigger className="h-9 w-auto gap-2 border-border/60 bg-background/60 px-2 font-mono text-xs">
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
        ) : title ? null : (
          <span className="shrink-0 font-mono text-xs">{active.name}</span>
        )}

        {/* Why this output may not be the whole story. */}
        <LogNoticeChip notice={notice} />

        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[11px]",
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
                    : "bg-ring",
            )}
          />
          {statusLabel[status]}
        </span>

        <LogSearch
          value={filters.state.q}
          onChange={(q) => filters.setState((s) => ({ ...s, q }))}
          className="basis-full sm:basis-auto"
        />
        <LogLevelFilter
          facet={filters.facet}
          values={filters.state.levels}
          counts={filters.counts}
          onChange={(levels) => filters.setState((s) => ({ ...s, levels }))}
        />
        <TimelineMenu
          value={timeline}
          onChange={setTimeline}
          maxDays={logMaxDays}
          disabled={!supportsTimeline}
        />

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <SimpleTooltip
            content={follow ? "Pause auto-scroll" : "Resume auto-scroll"}
          >
            <Button
              variant="ghost"
              onClick={() => (follow ? setFollow(false) : resumeFollow())}
              aria-label={follow ? "Pause auto-scroll" : "Resume auto-scroll"}
              className="size-9"
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
              variant="ghost"
              onClick={clear}
              aria-label="Clear"
              className="size-9"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </SimpleTooltip>
          <LogsDisplayMenu />
          <CopyButton value={plainOutput} className="size-9" />
          <DownloadButton
            value={plainOutput}
            filename={`${active.name}.log`}
            className="size-9"
          />
          {status === "ended" || status === "error" ? (
            <SimpleTooltip content="Reconnect">
              <Button
                variant="ghost"
                onClick={reconnect}
                aria-label="Reconnect"
                className="size-9"
              >
                <RotateCcw className="size-3.5" />
              </Button>
            </SimpleTooltip>
          ) : null}
        </div>
      </div>

      <LogLines ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1">
        {filters.shown.map((l, i) => (
          <LogRow
            key={i}
            level={l.level}
            text={l.text}
            time={
              l.ts && timeline.timestamps
                ? formatLogClock(l.ts, timeline.format, nowMs)
                : undefined
            }
            tintMessage={false}
            zebra={i % 2 === 1}
            chip="auto"
            highlight={filters.highlight}
          />
        ))}

        {/* Empty for three different reasons - a filter is one of them. */}
        {lines.length > 0 && filters.shown.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <FileSearch className="size-5 text-zinc-500" />
            <p className="text-[11px] text-zinc-500">
              No log lines match your filters.
            </p>
          </div>
        ) : null}

        {status === "connecting" && !output ? (
          <p className="text-[11px] text-zinc-500">
            Connecting to the log stream
          </p>
        ) : null}

        {status === "reattaching" ? (
          <p className="mt-1 text-[11px] text-[var(--warning)]">
            The container exited - waiting for docker to restart it, then
            picking the stream back up.
          </p>
        ) : null}

        {(status === "live" || busy) && output === "" && !failure ? (
          <p className="mt-1 text-[11px] text-zinc-500">
            No output yet - new log lines will appear here as the container
            emits them.
          </p>
        ) : null}

        {failure ? (
          <p className="mt-1 text-[11px] text-destructive">{failure}</p>
        ) : null}

        {/* The stream never opened and said nothing about why. */}
        {(status === "error" || status === "ended") &&
        output === "" &&
        !failure ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <PlugZap className="size-5 text-zinc-500" />
            <p className="max-w-100 text-[11px] text-zinc-500">
              The log stream could not be opened. The container may be gone, or
              its server unreachable. Use Reconnect to try again.
            </p>
          </div>
        ) : null}
      </LogLines>
    </div>
  );
}
