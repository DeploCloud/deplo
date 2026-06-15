"use client";

import * as React from "react";
import { TerminalSquare, Plug, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { execConsoleAction } from "@/lib/actions/console";
import { cn } from "@/lib/utils";

interface Line {
  kind: "in" | "out" | "sys";
  text: string;
}

export function ContainerConsole({
  projectId,
  containerName,
  image,
  user,
}: {
  projectId: string;
  containerName: string;
  image: string;
  user: string;
}) {
  const prompt = `${user}@${containerName}:/app$`;

  const banner: Line[] = React.useMemo(
    () => [
      { kind: "sys", text: `Attaching to ${containerName} (${image})...` },
      { kind: "sys", text: "Connected. Type 'help' for commands, 'exit' to detach." },
    ],
    [containerName, image]
  );

  const [lines, setLines] = React.useState<Line[]>(banner);
  const [value, setValue] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const [attached, setAttached] = React.useState(true);
  const history = React.useRef<string[]>([]);
  const histIdx = React.useRef<number>(-1);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, pending]);

  function focusInput() {
    inputRef.current?.focus();
  }

  function reconnect() {
    setLines(banner);
    setAttached(true);
    setValue("");
    setTimeout(focusInput, 0);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const command = value;
    if (!command.trim() || pending || !attached) return;
    history.current.unshift(command);
    histIdx.current = -1;
    setValue("");
    setLines((prev) => [...prev, { kind: "in", text: `${prompt} ${command}` }]);

    startTransition(async () => {
      const res = await execConsoleAction({ projectId, command });
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
          { kind: "sys", text: "Detached from container." },
        ]);
        setAttached(false);
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
        <span className="font-mono text-xs">{containerName}</span>
        <Badge variant={attached ? "success" : "muted"} className="gap-1">
          <Plug className="size-3" />
          {attached ? "attached" : "detached"}
        </Badge>
        <span className="ml-auto truncate font-mono text-[11px] text-muted-foreground">
          {image}
        </span>
      </div>

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

        {attached ? (
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
          <Button size="sm" variant="outline" onClick={reconnect} className="mt-2">
            <RotateCcw className="size-4" />
            Reconnect
          </Button>
        )}
      </div>
    </div>
  );
}
