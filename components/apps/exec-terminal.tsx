"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import { XtermView, type XtermApi } from "@/components/apps/xterm-lazy";

// SGR wrappers — the exec pane colours its own chrome (prompt/banner/errors);
// command OUTPUT is written verbatim so the container's own ANSI renders.
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Container output uses lone \n; a terminal needs \r\n or lines stair-step. */
const toCrlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/**
 * The stateless `docker exec` REPL, rendered in an xterm.js terminal with a
 * local line editor. Each entered line is ONE `execConsole` round-trip (no
 * persistent shell — a `cd` never sticks), and the response is written straight
 * into the terminal so the container's colours/escapes render for real.
 *
 * The editor handles echo, Backspace, ↑/↓ history, Ctrl-C (cancel line) and
 * Ctrl-L (clear); input is frozen while a command is in flight. Remounted per
 * instance by the parent (keyed on the container name), so its banner/prompt are
 * fixed for the life of a mount.
 */
export function ExecTerminal({
  appId,
  containerName,
  prompt,
  banner,
  note,
}: {
  appId: string;
  containerName: string;
  /** e.g. `root@web$` — no trailing space (added with the prompt colour). */
  prompt: string;
  /** System lines printed above the first prompt. */
  banner: string[];
  /** Late-resolved distroless caveat, appended once when it arrives. */
  note: string | null;
}) {
  const term = React.useRef<XtermApi | null>(null);
  const line = React.useRef("");
  const history = React.useRef<string[]>([]);
  const histIdx = React.useRef(-1);
  const busy = React.useRef(false);
  const open = React.useRef(true);
  const noteWritten = React.useRef(false);
  const [closed, setClosed] = React.useState(false);

  const promptStr = `${GREEN(prompt)} `;

  const writeBanner = React.useCallback(
    (a: XtermApi) => {
      for (const b of banner) a.write(CYAN(b) + "\r\n");
      if (note) {
        a.write(CYAN(note) + "\r\n");
        noteWritten.current = true;
      }
      a.write(promptStr);
    },
    [banner, note, promptStr],
  );

  function onReady(api: XtermApi) {
    term.current = api;
    writeBanner(api);
    api.focus();
  }

  // The distroless caveat can land after mount (the shell probe is async). Slot
  // it in above the live prompt, then redraw the prompt + whatever's typed.
  React.useEffect(() => {
    const a = term.current;
    if (!note || noteWritten.current || !a || !open.current) return;
    noteWritten.current = true;
    a.write("\r\x1b[K" + CYAN(note) + "\r\n" + promptStr + line.current);
  }, [note, promptStr]);

  /** Print command output, guaranteeing a fresh line before the next prompt. */
  function writeOutput(text: string) {
    const a = term.current;
    if (!a) return;
    a.write(text);
    if (!text.endsWith("\n")) a.write("\r\n");
  }

  async function run(command: string) {
    busy.current = true;
    const res = await gqlAction(
      `mutation($input: ExecConsoleInput!){ execConsole(input: $input) { output detach } }`,
      { input: { appId, command, containerName } },
      (d: { execConsole: { output: string; detach?: boolean } }) => d.execConsole,
    );
    busy.current = false;
    const a = term.current;
    if (!a) return;

    if (!res.ok) {
      writeOutput(RED(res.error));
      a.write(promptStr);
      return;
    }
    const out = res.data!;
    if (out.output === "\f") {
      a.reset();
      a.write(promptStr);
      return;
    }
    if (out.output) writeOutput(toCrlf(out.output));
    if (out.detach) {
      writeOutput(CYAN("Session closed."));
      open.current = false;
      setClosed(true);
      return;
    }
    a.write(promptStr);
  }

  function replaceLine(value: string) {
    line.current = value;
    // \r → col 0, \x1b[K → clear to EOL, then redraw prompt + value.
    term.current?.write("\r\x1b[K" + promptStr + value);
  }

  function onData(d: string) {
    if (!open.current || busy.current) return;
    const a = term.current;
    if (!a) return;

    switch (d) {
      case "\r": {
        a.write("\r\n");
        const cmd = line.current;
        line.current = "";
        if (!cmd.trim()) {
          a.write(promptStr);
          return;
        }
        history.current.unshift(cmd);
        histIdx.current = -1;
        void run(cmd);
        return;
      }
      case "\x7f": // Backspace
        if (line.current.length > 0) {
          line.current = line.current.slice(0, -1);
          a.write("\b \b");
        }
        return;
      case "\x03": // Ctrl-C: abandon the current line
        a.write("^C\r\n" + promptStr);
        line.current = "";
        return;
      case "\x0c": // Ctrl-L: clear, keep the line being typed
        a.reset();
        a.write(promptStr + line.current);
        return;
      case "\x1b[A": {
        // ↑ older
        const next = Math.min(histIdx.current + 1, history.current.length - 1);
        if (next < 0) return;
        histIdx.current = next;
        replaceLine(history.current[next]);
        return;
      }
      case "\x1b[B": {
        // ↓ newer (past the newest → empty line)
        const next = histIdx.current - 1;
        histIdx.current = next;
        replaceLine(next >= 0 ? history.current[next] : "");
        return;
      }
    }

    // Ignore every other escape sequence (←/→/Home/Del/F-keys): this editor is
    // append-only, so honouring mid-line cursor moves would desync the buffer.
    if (d.charCodeAt(0) === 0x1b) return;

    const printable = [...d].filter((ch) => ch >= " " && ch !== "\x7f").join("");
    if (!printable) return;
    line.current += printable;
    a.write(printable);
  }

  function newSession() {
    const a = term.current;
    if (!a) return;
    open.current = true;
    line.current = "";
    history.current = [];
    histIdx.current = -1;
    setClosed(false);
    a.reset();
    writeBanner(a);
    a.focus();
  }

  return (
    <>
      <div className="h-[420px] bg-[#0a0a0a] p-2">
        <XtermView onReady={onReady} onData={onData} className="h-full w-full" />
      </div>
      {closed ? (
        <div className="flex items-center gap-2 border-t border-border bg-secondary/20 px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            The exec session was closed.
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={newSession}
            className="ml-auto h-7"
          >
            <RotateCcw className="size-4" />
            New session
          </Button>
        </div>
      ) : null}
    </>
  );
}
