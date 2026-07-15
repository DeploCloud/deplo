"use client";

import "@xterm/xterm/css/xterm.css";

import * as React from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

/**
 * The imperative surface a parent drives a mounted terminal through. Handed back
 * once via `onReady` (a ref would have to thread through `next/dynamic`, which
 * doesn't forward them). `fit()` re-measures and returns the resulting size so
 * the caller can seed/resize the backing pty.
 */
export interface XtermApi {
  write: (data: string) => void;
  /** Wipe the viewport + scrollback and home the cursor. */
  reset: () => void;
  focus: () => void;
  fit: () => { cols: number; rows: number };
  getSize: () => { cols: number; rows: number };
}

// One dark theme for every terminal, tuned to the console pane's near-black
// background so the widget doesn't read as a lighter box floating on black.
const THEME: ITerminalOptions["theme"] = {
  background: "#0a0a0a",
  foreground: "#e4e4e7", // zinc-200
  cursor: "#22c55e",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3f3f46", // zinc-700
  black: "#18181b",
  brightBlack: "#52525b",
};

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * A thin `@xterm/xterm` wrapper: mounts a real terminal emulator, fits it to its
 * container (and refits on resize), and pumps keystrokes/resizes out through
 * callbacks. Rendering-only — the caller owns the data on both ends (an attach
 * stream, or a local exec line-editor). Loaded exclusively via `xterm-lazy` so
 * the ~55–80KB emulator is code-split to the console route and never touches SSR.
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
  /** New size after any fit — mount, container resize, font change. */
  onResize?: (cols: number, rows: number) => void;
  /** Fired once, right after the terminal is open and first-fitted. */
  onReady?: (api: XtermApi) => void;
  /** Hide the cursor and drop stdin (output-only panes). */
  readOnly?: boolean;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  // Latest callbacks behind refs so the mount effect runs exactly once — a new
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
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const doFit = () => {
      try {
        fit.fit();
      } catch {
        /* zero-sized host (not laid out yet) — the ResizeObserver refits later */
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
