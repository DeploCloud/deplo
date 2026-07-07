"use client";

import * as React from "react";
import { Terminal, useTerminal } from "@wterm/react";
import "@wterm/react/css";
import { TerminalSquare, Boxes, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/shared/empty-state";
import { gql } from "@/lib/graphql-client";
import { useLiveRunning } from "@/components/services/service-live-status";
import type { ConsoleInstance } from "@/lib/data/console";
import { cn } from "@/lib/utils";

type ConsoleInfo = {
  containerName: string;
  image: string;
  instances: ConsoleInstance[];
};

const CONSOLE_INFO_QUERY = /* GraphQL */ `
  query ConsoleInfo($serviceId: String!) {
    consoleInfo(serviceId: $serviceId) {
      containerName
      image
      running
      instances {
        name
        service
        image
        running
        exposed
        user
        workdir
        openStdin
        tty
      }
    }
  }
`;

type ConsoleInfoResponse = {
  consoleInfo: (ConsoleInfo & { running: boolean }) | null;
};

/**
 * Console page body backed by the wterm terminal emulator (vercel-labs/wterm).
 * Follows the service's live running state — terminal ↔ "not running" empty state,
 * no reload — like the legacy LiveConsole it replaces. When running it attaches a
 * real VT terminal to the container's PID-1 PTY over the existing SSE(out)+POST(in)
 * transport (`/api/services/:id/attach`).
 *
 * The previous exec-REPL console (LiveConsole/ContainerConsole/ContainerAttach) is
 * kept intact and unused as a restore point — repoint the console page's import
 * back to `LiveConsole` to bring it back (also tagged `console-legacy-pre-wterm`).
 */
export function WtermLiveConsole({
  serviceId,
  initialInfo,
  initialRunning,
}: {
  serviceId: string;
  initialInfo: ConsoleInfo | null;
  initialRunning: boolean;
}) {
  const running = useLiveRunning(initialRunning);
  const [info, setInfo] = React.useState<ConsoleInfo | null>(
    initialRunning ? initialInfo : null,
  );
  const loading = running && !info;

  React.useEffect(() => {
    if (!running) return;
    let cancelled = false;
    gql<ConsoleInfoResponse>(CONSOLE_INFO_QUERY, { serviceId })
      .then((data) => {
        if (cancelled) return;
        const ci = data.consoleInfo;
        setInfo(
          ci?.running
            ? {
                containerName: ci.containerName,
                image: ci.image,
                instances: ci.instances,
              }
            : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, serviceId]);

  if (running && info) {
    return <WtermConsole serviceId={serviceId} info={info} />;
  }

  return (
    <EmptyState
      icon={TerminalSquare}
      title={loading ? "Connecting to container…" : "Container is not running"}
      description={
        loading
          ? "The service just started — attaching to the console."
          : "The console is available once the service has a running deployment. Deploy or redeploy this service, then attach."
      }
    />
  );
}

/** Terminal chrome: instance switcher + running badge, over the wterm terminal. */
function WtermConsole({
  serviceId,
  info,
}: {
  serviceId: string;
  info: ConsoleInfo;
}) {
  const { containerName, image, instances } = info;
  const [active, setActive] = React.useState<ConsoleInstance>(() => {
    const match = instances.find((i) => i.name === containerName);
    return (
      match ??
      instances[0] ?? {
        name: containerName,
        service: containerName,
        image,
        running: true,
        exposed: true,
        user: "root",
        workdir: "/",
        openStdin: true,
        tty: true,
      }
    );
  });

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (next) setActive(next);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <TerminalSquare className="size-4 text-muted-foreground" />
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
        <Badge variant={active.running ? "success" : "muted"} className="gap-1">
          <span
            className={cn(
              "size-2 rounded-full",
              active.running
                ? "bg-[var(--success)]"
                : "bg-muted-foreground/50",
            )}
          />
          {active.running ? "running" : "stopped"}
        </Badge>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {active.workdir} · {active.image}
        </span>
      </div>

      {/* Remount on instance switch so the terminal + attach session are fresh. */}
      <WtermAttach
        key={active.name}
        serviceId={serviceId}
        containerName={active.name}
      />
    </div>
  );
}

type Status = "connecting" | "live" | "ended" | "error";

/**
 * A wterm terminal bound to one container's PID-1 PTY. Output streams in over the
 * attach SSE endpoint and is written to the terminal; raw keystrokes the terminal
 * emits (onData) are POSTed to the same session's stdin — a true interactive
 * terminal (raw mode), unlike the legacy line-mode attach.
 */
function WtermAttach({
  serviceId,
  containerName,
}: {
  serviceId: string;
  containerName: string;
}) {
  const { ref, write } = useTerminal();
  // `write` may change identity across renders; read it through a ref so the
  // stream effect never has to re-run just to pick up a new writer.
  const writeRef = React.useRef(write);
  React.useEffect(() => {
    writeRef.current = write;
  }, [write]);

  const sessionId = React.useRef<string | null>(null);
  const [status, setStatus] = React.useState<Status>("connecting");
  const [attempt, setAttempt] = React.useState(0);

  // Output can arrive before the WASM terminal has finished loading; buffer it
  // until `onReady` fires, then flush, so the opening bytes are never dropped.
  // `ready` reflects the (persistent) terminal instance, so it is NOT reset on a
  // reconnect — only the very first mount waits for onReady.
  const ready = React.useRef(false);
  const pendingWrites = React.useRef<string[]>([]);
  const push = React.useCallback((text: string) => {
    if (ready.current) writeRef.current(text);
    else pendingWrites.current.push(text);
  }, []);

  const base = `/api/services/${encodeURIComponent(serviceId)}/attach`;

  React.useEffect(() => {
    const url = `${base}?container=${encodeURIComponent(containerName)}`;
    const es = new EventSource(url);

    es.addEventListener("session", (e) => {
      sessionId.current = JSON.parse((e as MessageEvent).data);
      setStatus("live");
    });
    es.addEventListener("data", (e) => {
      push(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("exit", () => {
      setStatus("ended");
      es.close();
    });
    es.onerror = () => {
      // No `session` frame yet ⇒ the attach failed (stopped/404); once live an
      // error just means the stream ended.
      setStatus((s) => (s === "live" ? "ended" : "error"));
      es.close();
    };

    return () => {
      es.close();
      // Best-effort detach so the server reaps the attach child promptly.
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
  }, [base, containerName, attempt, push]);

  // Raw keystrokes from the terminal → the container's PTY stdin.
  const onData = React.useCallback(
    (data: string) => {
      const id = sessionId.current;
      if (!id) return;
      fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, data }),
      }).catch(() => {});
    },
    [base],
  );

  function reconnect() {
    sessionId.current = null;
    setStatus("connecting");
    setAttempt((n) => n + 1);
  }

  return (
    <div className="relative bg-black/90">
      <Terminal
        ref={ref}
        cols={80}
        rows={24}
        cursorBlink
        onData={onData}
        onReady={() => {
          ready.current = true;
          for (const text of pendingWrites.current) writeRef.current(text);
          pendingWrites.current = [];
        }}
        className="h-[440px] w-full overflow-hidden p-3"
      />
      {(status === "ended" || status === "error") && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-sm text-zinc-300">
          <span>{status === "error" ? "Attach failed." : "Session ended."}</span>
          <Button size="sm" variant="outline" onClick={reconnect}>
            <RotateCcw className="size-4" />
            Reconnect
          </Button>
        </div>
      )}
    </div>
  );
}
