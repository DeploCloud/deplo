"use client";

import * as React from "react";
import { TerminalSquare, Boxes, Plug } from "lucide-react";
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
import { ContainerAttach } from "@/components/apps/container-attach";
import { ExecTerminal } from "@/components/apps/exec-terminal";
import { cn } from "@/lib/utils";

const DISTROLESS_NOTE =
  "! No shell in this container (distroless). Commands run as raw exec: first word is the binary, the rest are literal arguments — no pipes, globbing, redirects, or shell builtins.";

export function ContainerConsole({
  appId,
  containerName,
  image,
  instances,
}: {
  appId: string;
  containerName: string;
  image: string;
  instances: ConsoleInstance[];
}) {
  // The shell label is resolved after mount (the page no longer blocks on the
  // ≤4 docker-exec shell probe). null = not yet known; once it resolves to
  // "raw exec (no shell)" the distroless notice is shown for the default box.
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
    (inst: ConsoleInstance): string[] => [
      `Opening exec session on ${inst.name} (${inst.image})...`,
      "Type a command, or 'exit' to close the session.",
    ],
    [],
  );

  // The distroless caveat reflects the DEFAULT container's probe only (switching
  // to another instance won't re-probe); ExecTerminal appends it once it lands.
  const note =
    shell === "raw exec (no shell)" && active.name === containerName
      ? DISTROLESS_NOTE
      : null;

  // "exec" is the stateless docker-exec REPL; "attach" is a live docker-attach
  // stream to PID 1. Switching instance returns to exec (attach is per-active).
  const [mode, setMode] = React.useState<"exec" | "attach">("exec");

  // Resolve the default container's shell label after mount. The page renders
  // without waiting; the value only feeds `note` above.
  React.useEffect(() => {
    let live = true;
    gqlAction(
      `query($input: ShellLabelInput!){ shellLabel(input: $input) }`,
      { input: { appId, containerName } },
      (d: { shellLabel: string | null }) => ({ shell: d.shellLabel }),
    ).then((res) => {
      if (!live || !res.ok || !res.data?.shell) return;
      setShell(res.data.shell);
    });
    return () => {
      live = false;
    };
  }, [appId, containerName]);

  function switchInstance(name: string) {
    const next = instances.find((i) => i.name === name);
    if (!next || next.name === active.name) return;
    setActive(next);
    setMode("exec");
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
          appId={appId}
          containerName={active.name}
          openStdin={active.openStdin}
          tty={active.tty}
          embedded
        />
      ) : (
        <ExecTerminal
          key={active.name}
          appId={appId}
          containerName={active.name}
          prompt={prompt}
          banner={banner(active)}
          note={note}
        />
      )}
    </div>
  );
}
