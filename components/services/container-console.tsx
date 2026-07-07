"use client";

import * as React from "react";
import { TerminalSquare, RotateCcw, Boxes, Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { gqlAction } from "@/lib/graphql-client";
import type { ConsoleInstance } from "@/lib/data/console";
import { ContainerAttach } from "@/components/services/container-attach";
import { cn } from "@/lib/utils";

interface Line {
  kind: "in" | "out" | "sys";
  text: string;
}

const DISTROLESS_NOTE =
  "! No shell in this container (distroless). Commands run as raw exec: first word is the binary, the rest are literal arguments — no pipes, globbing, redirects, or shell builtins.";

export function ContainerConsole({
  serviceId,
  containerName,
  image,
  instances,
}: {
  serviceId: string;
  containerName: string;
  image: string;
  instances: ConsoleInstance[];
}) {
  // The shell label is resolved after mount (the page no longer blocks on the
  // ≤4 docker-exec shell probe). null = not yet known; once it resolves to
  // "raw exec (no shell)" the distroless notice is shown.
  const [shell, setShell] = React.useState<string | null>(null);
  // Active instance — defaults to the container the server picked. Switching
  // opens an exec session on a different container in the same stack.
  const [active, setActive] = React.useState(() => {
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
      }
    );
  });

  // No cwd in the prompt: each command is a separate, stateless `docker exec`,
  // so a `cd` never persists — showing a live path would imply a session that
  // doesn't exist. user@service is verifiable from `docker inspect`.
  const prompt = `${active.user}@${active.service}$`;

  const banner = React.useCallback(
    (inst: ConsoleInstance): Line[] => {
      const out: Line[] = [
        { kind: "sys", text: `Opening exec session on ${inst.name} (${inst.image})...` },
        { kind: "sys", text: "Type a command, or 'exit' to close the session." },
      ];
      // The probed shell label reflects the default instance; only flag the
      // raw-exec caveat there (switching to another instance won't re-probe).
      if (shell === "raw exec (no shell)" && inst.name === containerName) {
        out.push({ kind: "sys", text: DISTROLESS_NOTE });
      }
      return out;
    },
    [shell, containerName]
  );

  // "exec" is the stateless docker-exec REPL; "attach" is a live docker-attach
  // stream to PID 1. Switching instance returns to exec (attach is per-active).
  const [mode, setMode] = React.useState<"exec" | "attach">("exec");
  const [lines, setLines] = React.useState<Line[]>(() => banner(active));

  // Latest active instance name, for use inside the async shell-probe callback
  // below without re-running the probe when the user switches instances. Synced
  // in an effect (not during render) per the refs rule.
  const activeNameRef = React.useRef(active.name);
  React.useEffect(() => {
    activeNameRef.current = active.name;
  }, [active.name]);

  // Resolve the default container's shell label after mount. The page renders
  // without waiting on the probe; if the container turns out to be shell-less,
  // append the raw-exec notice to the current session (so it appears even though
  // the opening banner was rendered before the label was known). The setState
  // calls run in the async callback — a response to the probe completing, not a
  // synchronous effect-body update.
  React.useEffect(() => {
    let live = true;
    gqlAction(
      `query($input: ShellLabelInput!){ shellLabel(input: $input) }`,
      { input: { serviceId, containerName } },
      (d: { shellLabel: string | null }) => ({ shell: d.shellLabel }),
    ).then((res) => {
      if (!live || !res.ok || !res.data?.shell) return;
      const label = res.data.shell;
      setShell(label);
      // Annotate only the default container's current session, and only once.
      if (label === "raw exec (no shell)" && activeNameRef.current === containerName) {
        setLines((prev) =>
          prev.some((l) => l.text === DISTROLESS_NOTE)
            ? prev
            : [...prev, { kind: "sys", text: DISTROLESS_NOTE }],
        );
      }
    });
    return () => {
      live = false;
    };
  }, [serviceId, containerName]);
  const [value, setValue] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  // Whether the exec prompt is open. This console is a `docker exec`
  // request/response REPL, not a `docker attach` stream — so this tracks the
  // input prompt, not a live connection. Closed by `exit`, reopened by switch /
  // New session.
  const [sessionOpen, setSessionOpen] = React.useState(true);
  const history = React.useRef<string[]>([]);
  const histIdx = React.useRef<number>(-1);

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (!next || next.name === active.name) return;
    setActive(next);
    setMode("exec");
    setLines(banner(next));
    setSessionOpen(true);
    setValue("");
    history.current = [];
    histIdx.current = -1;
    setTimeout(focusInput, 0);
  }

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pending]);

  function focusInput() {
    inputRef.current?.focus();
  }

  function newSession() {
    setLines(banner(active));
    setSessionOpen(true);
    setValue("");
    setTimeout(focusInput, 0);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const command = value;
    if (!command.trim() || pending || !sessionOpen) return;
    history.current.unshift(command);
    histIdx.current = -1;
    setValue("");
    setLines((prev) => [...prev, { kind: "in", text: `${prompt} ${command}` }]);

    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: ExecConsoleInput!){ execConsole(input: $input) { output detach } }`,
        { input: { serviceId, command, containerName: active.name } },
        (d: { execConsole: { output: string; detach?: boolean } }) =>
          d.execConsole,
      );
      if (!res.ok) {
        setLines((prev) => [...prev, { kind: "sys", text: res.error }]);
        return;
      }
      const out = res.data!;
      if (out.output === "\f") {
        setLines([]); // clear
        return;
      }
      if (out.output) {
        setLines((prev) => [...prev, { kind: "out", text: out.output }]);
      }
      if (out.detach) {
        setLines((prev) => [
          ...prev,
          { kind: "sys", text: "Session closed." },
        ]);
        setSessionOpen(false);
      }
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx.current + 1, history.current.length - 1);
      if (next >= 0) {
        histIdx.current = next;
        setValue(history.current[next]);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = histIdx.current - 1;
      histIdx.current = next;
      setValue(next >= 0 ? history.current[next] : "");
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      setLines([]);
    }
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
                        inst.running ? "bg-[var(--success)]" : "bg-muted-foreground/50"
                      )}
                    />
                    {inst.service}
                    {inst.exposed ? (
                      <span className="text-[10px] text-muted-foreground">app</span>
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
              active.running ? "bg-[var(--success)]" : "bg-muted-foreground/50"
            )}
          />
          {active.running ? "running" : "stopped"}
        </Badge>
        {active.running ? (
          <Button
            size="sm"
            variant={mode === "attach" ? "secondary" : "ghost"}
            onClick={() => setMode((m) => (m === "attach" ? "exec" : "attach"))}
            className="h-7 gap-1.5 px-2 text-xs"
            aria-pressed={mode === "attach"}
          >
            <Plug className="size-3.5" />
            {mode === "attach" ? "Exec console" : "Attach"}
          </Button>
        ) : null}
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          workdir {active.workdir} · {active.image}
        </span>
      </div>

      {mode === "attach" ? (
        <ContainerAttach
          key={active.name}
          serviceId={serviceId}
          containerName={active.name}
          openStdin={active.openStdin}
          tty={active.tty}
          embedded
        />
      ) : (
      <div
        ref={scrollRef}
        onClick={focusInput}
        className="h-[420px] cursor-text overflow-y-auto bg-black/90 p-3 font-mono text-[13px] leading-relaxed text-zinc-200"
      >
        {lines.map((l, i) => (
          <pre
            key={i}
            className={cn(
              "whitespace-pre-wrap break-words",
              l.kind === "in" && "text-zinc-100",
              l.kind === "out" && "text-zinc-300",
              l.kind === "sys" && "text-[var(--success)]"
            )}
          >
            {l.text}
          </pre>
        ))}

        {sessionOpen ? (
          <form onSubmit={submit} className="flex items-center gap-2">
            <span className="shrink-0 text-[var(--success)]">{prompt}</span>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={pending}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className="flex-1 border-0 bg-transparent font-mono text-[13px] text-zinc-100 outline-none placeholder:text-zinc-600"
              aria-label="Container command"
            />
          </form>
        ) : (
          <Button size="sm" variant="outline" onClick={newSession} className="mt-2">
            <RotateCcw className="size-4" />
            New session
          </Button>
        )}
      </div>
      )}
    </div>
  );
}
