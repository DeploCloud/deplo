"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/result";
import { LineEditor } from "@/lib/exec-line-editor";
import { XtermView, type XtermApi } from "@/components/apps/xterm-lazy";
import type { ConsoleControls } from "@/components/console/console-controls";

// SGR wrappers — the exec pane colours its own chrome (prompt/banner/errors);
// command OUTPUT is written verbatim so the container's own ANSI renders.
const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const CYAN = (s: string) => `\x1b[36m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;

/** Container output uses lone \n; a terminal needs \r\n or lines stair-step. */
const toCrlf = (s: string) => s.replace(/\r?\n/g, "\r\n");

/**
 * The stateless `docker exec` REPL, rendered in an xterm.js terminal with a local
 * line editor.
 */
export function ExecTerminal({
  prompt,
  banner,
  note,
  exec,
  onControls,
}: {
  /** e.g. `root@web$` — no trailing space (added with the prompt colour). */
  prompt: string;
  /** System lines printed above the first prompt. */
  banner: string[];
  /** Late-resolved distroless caveat, appended once when it arrives. */
  note: string | null;
  /**
   * How a line is executed. The pane owns this — it is what applies the shell
   * wrapper and picks between the app's `execConsole` and a database's
   * `execDatabaseConsole` — so this component only has to render the REPL.
   */
  exec: (
    command: string,
  ) => Promise<ActionResult<{ output: string; detach?: boolean }>>;
  /** Hands the toolbar its Clear / Copy / Download handles once mounted. */
  onControls?: (controls: ConsoleControls) => void;
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
    // Clear is Ctrl-L, fed through the editor rather than reimplemented: it
    // wipes the screen AND repaints the prompt with the half-typed line intact,
    // which a bare `reset()` would swallow.
    onControlsRef.current?.({
      clear: () => {
        if (!busy.current) editor.current?.data("\x0c");
      },
      text: () => api.getText(),
    });
  }

  // Behind a ref so a fresh `onControls` closure each render never re-runs the
  // mount path — `onReady` fires exactly once per terminal.
  const onControlsRef = React.useRef(onControls);
  React.useEffect(() => {
    onControlsRef.current = onControls;
  });

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
    const res = await exec(command);
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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The terminal takes whatever height the pane has left — the route is
          full-bleed, so that is floor to ceiling. */}
      <div className="min-h-0 flex-1 bg-terminal p-2">
        <XtermView
          onReady={onReady}
          onData={onData}
          className="h-full w-full"
        />
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
            className="ml-auto"
          >
            <RotateCcw className="size-4" />
            New session
          </Button>
        </div>
      ) : null}
    </div>
  );
}
