"use client";

import "@xterm/xterm/css/xterm.css";

import * as React from "react";
import { Terminal, type ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

// XtermApi is the imperative surface a parent drives a mounted terminal through.
export interface XtermApi {
  write: (data: string) => void;
  reset: () => void;
  focus: () => void;
  fit: () => { cols: number; rows: number };
  getSize: () => { cols: number; rows: number };
  getText: () => string;
}

const THEME: ITerminalOptions["theme"] = {
  foreground: "#e4e4e7",
  cursor: "#22c55e",
  cursorAccent: "#0a0a0a",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  brightBlack: "#52525b",
};

// xterm parses colours itself and does not understand var().
function terminalBackground(node: HTMLElement): string {
  return getComputedStyle(node).getPropertyValue("--terminal").trim() || "#000";
}

const FONT_FAMILY =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

// XtermView mounts an xterm terminal, fits it to its container, and pumps keystrokes out.
export function XtermView({
  onData,
  onResize,
  onReady,
  readOnly = false,
  className,
}: {
  onData?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onReady?: (api: XtermApi) => void;
  readOnly?: boolean;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
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
      convertEol: false,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily: FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: { ...THEME, background: terminalBackground(host) },
      // A hyperlink in container output must not become a click in the panel.
      linkHandler: { activate: () => {} },
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
        // xterm has no buffer-to-string API; reading back a select-all is the supported way.
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
  }, [readOnly]);

  return <div ref={hostRef} className={className} />;
}
