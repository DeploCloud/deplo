"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { gqlAction } from "@/lib/graphql-client";
import { LineEditor } from "@/lib/exec-line-editor";
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
 * Line editing (echo, caret movement with ←/→/Home/End, mid-line insert and
 * delete, ↑/↓ history, Ctrl-C/L and the readline kill/word chords) lives in
 * `lib/exec-line-editor.ts`; input is frozen while a command is in flight.
 * Remounted per instance by the parent (keyed on the container name), so its
 * banner/prompt are fixed for the life of a mount.
 */
export function ExecTerminal({
  appId,
  containerName,
  prompt,
  banner,
  note,
  exec,
}: {
  appId: string;
  containerName: string;
  /** e.g. `root@web$` — no trailing space (added with the prompt colour). */
  prompt: string;
  /** System lines printed above the first prompt. */
  banner: string[];
  /** Late-resolved distroless caveat, appended once when it arrives. */
  note: string | null;
  /**
   * Override how a line is executed — the database console routes through
   * `execDatabaseConsole`. Default: the app `execConsole` mutation for
   * `appId`/`containerName`. Must resolve to the same ActionResult contract.
   */
  exec?: (
    command: string,
  ) => Promise<
    | { ok: true; data: { output: string; detach?: boolean } }
    | { ok: false; error: string }
  >;
}) {
  const term = React.useRef<XtermApi | null>(null);
  const editor = React.useRef<LineEditor | null>(null);
  const busy = React.useRef(false);
  const open = React.useRef(true);
  const noteWritten = React.useRef(false);
  const [closed, setClosed] = React.useState(false);

  const promptStr = `${GREEN(prompt)} `;

  function writeBanner(a: XtermApi) {
    for (const b of banner) a.write(CYAN(b) + "\r\n");
    if (note) {
      a.write(CYAN(note) + "\r\n");
      noteWritten.current = true;
    }
    editor.current?.freshPrompt();
  }

  function onReady(api: XtermApi) {
    term.current = api;
    editor.current = new LineEditor(
      {
        write: (d) => api.write(d),
        cols: () => api.getSize().cols,
        reset: () => api.reset(),
      },
      promptStr,
      // Visible prompt width: the SGR wrapper is zero-width, +1 = the space.
      prompt.length + 1,
      (cmd) => void run(cmd),
    );
    writeBanner(api);
    api.focus();
  }

  // The distroless caveat can land after mount (the shell probe is async).
  // Slot it in above the live prompt, preserving the line being typed.
  React.useEffect(() => {
    const ed = editor.current;
    if (!note || noteWritten.current || !ed || !open.current) return;
    noteWritten.current = true;
    ed.insertAbove(CYAN(note));
  }, [note]);

  /** Print command output, guaranteeing a fresh line before the next prompt. */
  function writeOutput(text: string) {
    const a = term.current;
    if (!a) return;
    a.write(text);
    if (!text.endsWith("\n")) a.write("\r\n");
  }

  async function run(command: string) {
    busy.current = true;
    const res = exec
      ? await exec(command)
      : await gqlAction(
          `mutation($input: ExecConsoleInput!){ execConsole(input: $input) { output detach } }`,
          { input: { appId, command, containerName } },
          (d: { execConsole: { output: string; detach?: boolean } }) =>
            d.execConsole,
        );
    busy.current = false;
    const a = term.current;
    const ed = editor.current;
    if (!a || !ed) return;

    if (!res.ok) {
      writeOutput(RED(res.error));
      ed.freshPrompt();
      return;
    }
    const out = res.data!;
    if (out.output === "\f") {
      a.reset();
      ed.freshPrompt();
      return;
    }
    if (out.output) writeOutput(toCrlf(out.output));
    if (out.detach) {
      writeOutput(CYAN("Session closed."));
      open.current = false;
      setClosed(true);
      return;
    }
    ed.freshPrompt();
  }

  function onData(d: string) {
    if (!open.current || busy.current) return;
    editor.current?.data(d);
  }

  function newSession() {
    const a = term.current;
    const ed = editor.current;
    if (!a || !ed) return;
    open.current = true;
    ed.resetSession();
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
