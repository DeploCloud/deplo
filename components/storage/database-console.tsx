"use client";

import * as React from "react";
import { TerminalSquare, Plug } from "lucide-react";
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
import { gqlAction } from "@/lib/graphql-client";
import { ContainerAttach } from "@/components/apps/container-attach";
import { ExecTerminal } from "@/components/apps/exec-terminal";
import { useLiveDatabaseStatus } from "@/components/storage/database-live-status";
import type { DatabaseStatus } from "@/lib/types";

const DISTROLESS_NOTE =
  "! No shell in this container. Commands run as raw exec: first word is the binary, the rest are literal arguments — no pipes, globbing, redirects, or shell builtins. Pick a shell above to wrap commands.";

/** How each console line is executed. "auto" = raw docker exec (the first word
 *  is the binary); "sh"/"bash" wrap the line so pipes/redirects/builtins work. */
type Shell = "auto" | "sh" | "bash";

/**
 * The database console — a single-container twin of ContainerConsole. Exec REPL
 * (via execDatabaseConsole) with a shell picker, plus a live attach toggle
 * (ContainerAttach pointed at the database attach route). Follows the live
 * running state: while stopped it shows a hint instead of a dead terminal.
 */
export function DatabaseConsole({
  id,
  status: serverStatus,
  containerName,
  image,
}: {
  id: string;
  status: DatabaseStatus;
  containerName: string;
  image: string;
}) {
  const status = useLiveDatabaseStatus(serverStatus);
  const running = status === "running";
  const [shellLabel, setShellLabel] = React.useState<string | null>(null);
  const [shell, setShell] = React.useState<Shell>("auto");
  const [mode, setMode] = React.useState<"exec" | "attach">("exec");

  // Resolve the container's shell label after mount (the ≤4-exec probe never
  // blocks the page). Only feeds the distroless note for the auto shell.
  React.useEffect(() => {
    if (!running) return;
    let live = true;
    gqlAction(
      `query($databaseId: String!){ databaseShellLabel(databaseId: $databaseId) }`,
      { databaseId: id },
      (d: { databaseShellLabel: string | null }) => ({ shell: d.databaseShellLabel }),
    ).then((res) => {
      if (!live || !res.ok || !res.data?.shell) return;
      setShellLabel(res.data.shell);
    });
    return () => {
      live = false;
    };
  }, [id, running]);

  const prompt = `root@${containerName}$`;
  const banner = [
    `Opening exec session on ${containerName} (${image})...`,
    "Type a command, or 'exit' to close the session.",
  ];
  const note =
    shell === "auto" && shellLabel === "raw exec (no shell)"
      ? DISTROLESS_NOTE
      : null;

  // The exec callback threads through execDatabaseConsole. A non-auto shell
  // wraps the raw line client-side as `<shell> -lc '<line>'` so pipes/redirects
  // work without any server change (single-quotes in the line are escaped).
  const exec = React.useCallback(
    async (command: string) => {
      const wrapped =
        shell === "auto"
          ? command
          : `${shell} -lc '${command.replace(/'/g, "'\\''")}'`;
      return gqlAction(
        `mutation($input: ExecDatabaseConsoleInput!){ execDatabaseConsole(input: $input) { output detach } }`,
        { input: { databaseId: id, command: wrapped } },
        (d: { execDatabaseConsole: { output: string; detach?: boolean } }) =>
          d.execDatabaseConsole,
      );
    },
    [id, shell],
  );

  if (!running) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
        Start the database to open a console into its container.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
        <TerminalSquare className="size-4 text-muted-foreground" />
        <span className="font-mono text-xs">{containerName}</span>
        <Badge variant="success" className="gap-1">
          <span className="size-2 rounded-full bg-[var(--success)]" />
          running
        </Badge>
        {mode === "exec" && (
          <SimpleTooltip content="Run each command through a shell so pipes, redirects and builtins work. 'auto' is a raw docker exec (first word = the binary).">
            <Select value={shell} onValueChange={(v) => setShell(v as Shell)}>
              <SelectTrigger className="h-7 w-auto gap-2 border-border/60 bg-background/60 px-2 font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="font-mono text-xs">
                  auto
                </SelectItem>
                <SelectItem value="sh" className="font-mono text-xs">
                  /bin/sh
                </SelectItem>
                <SelectItem value="bash" className="font-mono text-xs">
                  /bin/bash
                </SelectItem>
              </SelectContent>
            </Select>
          </SimpleTooltip>
        )}
        <SimpleTooltip
          content={
            mode === "attach"
              ? "Back to the exec console — run one-off commands (docker exec)."
              : "Attach to the container's main process (PID 1): watch its live output and type to its stdin. Detaching never stops the container."
          }
        >
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
        </SimpleTooltip>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {image}
        </span>
      </div>

      {mode === "attach" ? (
        <ContainerAttach
          appId={id}
          containerName={containerName}
          openStdin
          tty
          embedded
          apiBase={`/api/databases/${encodeURIComponent(id)}/attach`}
        />
      ) : (
        <ExecTerminal
          key={shell}
          appId={id}
          containerName={containerName}
          prompt={prompt}
          banner={banner}
          note={note}
          exec={exec}
        />
      )}
    </div>
  );
}
