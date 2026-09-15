"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Boxes,
  Eraser,
  Plug,
  SquareTerminal,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
import {
  ContainerAttach,
  type AttachStatus,
} from "@/components/apps/container-attach";
import { ExecTerminal } from "@/components/apps/exec-terminal";
import {
  acknowledgeConsole,
  useConsoleAck,
} from "@/components/apps/console-ack";
import type { ConsoleControls } from "@/components/console/console-controls";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import type { ConsoleInstance } from "@/lib/data/console";
import { cn } from "@/lib/utils";
import { DocsLink } from "@/components/ui/docs-link";

type Shell = "auto" | "sh" | "bash";

const SHELLS: { value: Shell; label: string }[] = [
  { value: "auto", label: "auto" },
  { value: "sh", label: "/bin/sh" },
  { value: "bash", label: "/bin/bash" },
];

const DISTROLESS_NOTE =
  "! No shell in this container. Commands run as raw exec: the first word is the binary, the rest are literal arguments - no pipes, globbing, redirects or builtins.";

const CONTROL_WORDS = new Set(["exit", "logout", "clear"]);

function wrapForShell(line: string, shell: Shell): string {
  if (shell === "auto" || CONTROL_WORDS.has(line.trim())) return line;
  return `${shell} -lc '${line.replace(/'/g, "'\\''")}'`;
}

const ATTACH_LABEL: Record<AttachStatus, string> = {
  connecting: "connecting",
  live: "attached",
  ended: "detached",
  error: "attach failed",
};

export function ConsolePane({
  id,
  title,
  instances,
  initialName,
  attachBase,
  exec,
  probeShell,
}: {
  id: string;
  title: PaneTitle;
  instances: ConsoleInstance[];
  initialName: string;
  attachBase?: string;
  exec?: (
    command: string,
    containerName: string,
  ) => Promise<ActionResult<{ output: string; detach?: boolean }>>;
  probeShell: (containerName: string) => Promise<string | null>;
}) {
  const [active, setActive] = React.useState(
    () => instances.find((i) => i.name === initialName) ?? instances[0],
  );
  const [shell, setShell] = React.useState<Shell>("auto");
  const [mode, setMode] = React.useState<"exec" | "attach">("exec");
  const [attachStatus, setAttachStatus] =
    React.useState<AttachStatus>("connecting");
  const [controls, setControls] = React.useState<ConsoleControls | null>(null);

  const [probed, setProbed] = React.useState<{
    name: string;
    label: string | null;
  } | null>(null);
  React.useEffect(() => {
    let live = true;
    probeShell(active.name)
      .then((label) => {
        if (live) setProbed({ name: active.name, label });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active.name, probeShell]);
  const shellLabel = probed?.name === active.name ? probed.label : null;

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (!next || next.name === active.name) return;
    setActive(next);
    setMode("exec");
    setControls(null);
  }

  function switchMode(next: string) {
    setMode(next as "exec" | "attach");
    setControls(null);
  }

  const prompt = `${active.user}@${active.service}$`;

  const runLine = React.useCallback(
    (line: string) => {
      const command = wrapForShell(line, shell);
      return exec
        ? exec(command, active.name)
        : gqlAction(
            `mutation($input: ExecConsoleInput!){ execConsole(input: $input) { output detach } }`,
            { input: { appId: id, command, containerName: active.name } },
            (d: { execConsole: { output: string; detach?: boolean } }) =>
              d.execConsole,
          );
    },
    [exec, shell, active.name, id],
  );

  const note =
    shell === "auto" && shellLabel === "raw exec (no shell)"
      ? DISTROLESS_NOTE
      : null;

  const attachable = active.running;

  return (
    <Tabs
      value={mode}
      onValueChange={switchMode}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <PaneTitleLink title={title} />

        <SimpleTooltip
          content={`${active.name} · workdir ${active.workdir} · ${active.image}`}
        >
          {instances.length > 1 ? (
            <Select value={active.name} onValueChange={switchInstance}>
              <SelectTrigger className="h-9 w-auto gap-2 border-border/60 bg-background/60 px-2 font-mono text-xs">
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
                          inst.running ? "bg-[var(--success)]" : "bg-ring",
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
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {active.service}
            </span>
          )}
        </SimpleTooltip>

        <ConsoleStatus
          label={
            mode === "attach"
              ? ATTACH_LABEL[attachStatus]
              : active.running
                ? "running"
                : "stopped"
          }
          tone={
            mode === "attach"
              ? attachStatus === "live"
                ? "good"
                : attachStatus === "error"
                  ? "bad"
                  : "idle"
              : active.running
                ? "good"
                : "idle"
          }
          pulse={mode === "attach" && attachStatus === "live"}
        />

        {mode === "exec" ? (
          <SimpleTooltip content="Run each line through a shell so pipes, redirects and builtins work. 'auto' runs it raw - the first word is the binary.">
            <Select value={shell} onValueChange={(v) => setShell(v as Shell)}>
              <SelectTrigger className="h-9 w-auto gap-2 border-border/60 bg-background/60 px-2 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SHELLS.map((s) => (
                  <SelectItem
                    key={s.value}
                    value={s.value}
                    className="font-mono text-xs"
                  >
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SimpleTooltip>
        ) : null}

        <TabsList className="h-9 gap-0 rounded-lg border border-border bg-background/60 p-1">
          <TabsTrigger
            value="exec"
            className="px-2.5 py-1 text-xs data-[state=active]:bg-accent"
          >
            <SquareTerminal />
            Shell
          </TabsTrigger>
          <SimpleTooltip
            content={
              attachable
                ? "Watch the main process (PID 1) live and type to its stdin. Ctrl-C reaches the app; detaching never stops the container."
                : "The container isn't running, so there's no process to attach to."
            }
          >
            <span className="inline-flex">
              <TabsTrigger
                value="attach"
                disabled={!attachable}
                className="px-2.5 py-1 text-xs data-[state=active]:bg-accent"
              >
                <Plug />
                Attach
              </TabsTrigger>
            </span>
          </SimpleTooltip>
        </TabsList>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <SimpleTooltip content="Clear">
            <Button
              variant="ghost"
              onClick={() => controls?.clear()}
              disabled={!controls}
              aria-label="Clear"
              className="size-9"
            >
              <Eraser className="size-3.5" />
            </Button>
          </SimpleTooltip>
          <CopyButton
            value={() => controls?.text() ?? ""}
            size="icon"
            className="size-9"
          />
          <DownloadButton
            value={() => controls?.text() ?? ""}
            filename={`${active.name}.txt`}
            size="icon"
            className="size-9"
          />
        </div>
      </div>

      <ConsoleWarningGate href={title.href} />

      <TabsContent
        value="exec"
        className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"
      >
        <ExecTerminal
          key={`${active.name}:${shell}`}
          prompt={prompt}
          banner={[
            `Connected to ${active.name} (${active.image})`,
            "Type a command, or 'exit' to close the session.",
          ]}
          note={note}
          exec={runLine}
          onControls={setControls}
        />
      </TabsContent>

      <TabsContent
        value="attach"
        className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"
      >
        <ContainerAttach
          key={active.name}
          appId={id}
          containerName={active.name}
          openStdin={!!active.openStdin}
          apiBase={attachBase}
          onStatus={setAttachStatus}
          onControls={setControls}
        />
      </TabsContent>
    </Tabs>
  );
}

export function ConsoleEmpty({
  title,
  children,
}: {
  title: PaneTitle;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <PaneTitleLink title={title} />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {children}
      </div>
    </div>
  );
}

function ConsoleStatus({
  label,
  tone,
  pulse,
}: {
  label: string;
  tone: "good" | "bad" | "idle";
  pulse?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 text-[11px]",
        tone === "good"
          ? "text-[var(--success)]"
          : tone === "bad"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "good"
            ? "bg-[var(--success)]"
            : tone === "bad"
              ? "bg-destructive"
              : "bg-ring",
          pulse && "animate-pulse",
        )}
      />
      {label}
    </span>
  );
}

function ConsoleWarningGate({ href }: { href: string }) {
  const acknowledged = useConsoleAck();
  const router = useRouter();
  if (acknowledged !== false) return null;

  return (
    <Dialog open>
      <DialogContent
        hideClose
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        className="max-w-md"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriangleAlert className="size-5 text-[var(--warning)]" />
            Open the container console?
          </DialogTitle>
          <DialogDescription>
            A live terminal inside the running container.{" "}
            <strong>Commands take effect for real.</strong>{" "}
            <DocsLink topic="console.overview" />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => router.push(href)}>
            Leave page
          </Button>
          <Button onClick={acknowledgeConsole}>I understand</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
