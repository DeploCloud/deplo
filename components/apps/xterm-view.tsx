"use client";

import "@xterm/xterm/css/xterm.css";

import * as React from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/**
 * The imperative surface a parent drives a mounted terminal through. Handed back
 * once via `onReady` (a ref would have to thread through `next/dynamic`, which
 * doesn't forward them).
 */
export interface XtermApi {
  write: (data: string) => void;
  /** Wipe the viewport + scrollback and home the cursor. */
  reset: () => void;
  focus: () => void;
  fit: () => { cols: number; rows: number };
  getSize: () => { cols: number; rows: number };
  /** Everything on screen and in scrollback, as plain text - what the toolbar's
   *  Copy and Download hand out. Read at click time, never at render: the buffer
   *  changes on every keystroke and a snapshot prop would always be one behind. */
  getText: () => string;
}

// The ANSI palette every terminal here wears. `background` is filled in at mount
// from the --terminal token (see below) rather than repeated as a literal, so
// the emulator and the Tailwind slab around it can't drift apart.
const THEME: ITerminalOptions["theme"] = {
  foreground: "#e4e4e7", // zinc-200
  cursor: "#22c55e",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3f3f46", // zinc-700
  black: "#18181b",
  brightBlack: "#52525b",
};

/** The --terminal token's value, resolved off a mounted node. xterm parses
 *  colours itself and does not understand `var()`, so it needs the literal. */
function terminalBackground(node: HTMLElement): string {
  return getComputedStyle(node).getPropertyValue("--terminal").trim() || "#000";
}

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * A thin `@xterm/xterm` wrapper: mounts a real terminal emulator, fits it to its
 * container (and refits on resize), and pumps keystrokes/resizes out through
 * callbacks.
 */
export function XtermView({
  onData,
  onResize,
  onReady,
  readOnly = false,
  className,
}: {
  /** Raw keystroke bytes from the terminal (control sequences included). */
  onData?: (data: string) => void;
  /** New size after any fit - mount, container resize, font change. */
  onResize?: (cols: number, rows: number) => void;
  /** Fired once, right after the terminal is open and first-fitted. */
  onReady?: (api: XtermApi) => void;
  /** Hide the cursor and drop stdin (output-only panes). */
  readOnly?: boolean;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  // Latest callbacks behind refs so the mount effect runs exactly once - a new
  // `onData` closure each render must not tear down and rebuild the terminal.
  const onDataRef = React.useRef(onData);
  const onResizeRef = React.useRef(onResize);
  const onReadyRef = React.useRef(onReady);
  React.useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    onReadyRef.current = onReady;
  });

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: false, // both callers emit proper CRLF
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: { ...THEME, background: terminalBackground(host) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* zero-sized host (not laid out yet) - the ResizeObserver refits later */
      }
      return { cols: term.cols, rows: term.rows };
    };

    const dataSub = term.onData((d) => onDataRef.current?.(d));
    const resizeSub = term.onResize(({ cols, rows }) =>
      onResizeRef.current?.(cols, rows),
    );

    // Refit whenever the pane changes size (split-pane drag, window resize,
    // mode toggle). `onResize` above then propagates the new pty size.
    const ro = new ResizeObserver(() => doFit());
    ro.observe(host);

    doFit();
    onReadyRef.current?.({
      write: (d) => term.write(d),
      reset: () => term.reset(),
      focus: () => term.focus(),
      fit: doFit,
      getSize: () => ({ cols: term.cols, rows: term.rows }),
      getText: () => {
        // xterm has no buffer-to-string API; selecting everything and reading
        // the selection back is the supported way. The selection is cleared
        // again straight after, so the flash never outlives the click.
        term.selectAll();
        const text = term.getSelection();
        term.clearSelection();
        return text.replace(/\s+$/, "");
      },
    });

    return () => {
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
    };
    // readOnly is fixed per mount site; a change would warrant a fresh terminal.
  }, [readOnly]);

  return <div ref={hostRef} className={className} />;
}
