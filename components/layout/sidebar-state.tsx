"use client";

import * as React from "react";

const COLLAPSE_KEY = "deplo:sidebar-collapsed";
const WIDTH_KEY = "deplo:sidebar-width";
const MIN_WIDTH = 200;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;

const clampWidth = (n: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));

type SidebarState = {
  collapsed: boolean;
  /** False until the persisted preference has been read, so nothing animates on first paint. */
  hydrated: boolean;
  width: number;
  dragging: boolean;
  toggle: () => void;
  /** Pointer-drag on the sidebar's right edge; persists the width on release. */
  startResize: (e: React.PointerEvent) => void;
};

const SidebarContext = React.createContext<SidebarState | null>(null);

/**
 * Owns the desktop sidebar's collapsed flag and width. It lives above both the
 * sidebar and the topbar because the expand control sits in the topbar (the
 * sidebar itself collapses to zero width and has nowhere to host it). Both
 * values persist in localStorage.
 */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState({
    collapsed: false,
    hydrated: false,
    width: DEFAULT_WIDTH,
  });
  const [dragging, setDragging] = React.useState(false);
  const widthRef = React.useRef(DEFAULT_WIDTH);

  React.useEffect(() => {
    let storedCollapsed = false;
    let storedWidth = DEFAULT_WIDTH;
    try {
      storedCollapsed = window.localStorage.getItem(COLLAPSE_KEY) === "1";
      const w = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(w) && w > 0) storedWidth = clampWidth(w);
    } catch {
      /* ignore */
    }
    widthRef.current = storedWidth;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply persisted UI preference after mount
    setState({ collapsed: storedCollapsed, hydrated: true, width: storedWidth });
  }, []);

  const toggle = React.useCallback(() => {
    setState((prev) => {
      const next = !prev.collapsed;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return { ...prev, collapsed: next };
    });
  }, []);

  const startResize = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);

    function onMove(ev: PointerEvent) {
      const w = clampWidth(ev.clientX);
      widthRef.current = w;
      setState((prev) => ({ ...prev, width: w }));
    }
    function onUp() {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  // "[" toggles the sidebar from anywhere.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key !== "[") return;
      e.preventDefault();
      toggle();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  const value = React.useMemo<SidebarState>(
    () => ({ ...state, dragging, toggle, startResize }),
    [state, dragging, toggle, startResize],
  );

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

export function useSidebar(): SidebarState {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside <SidebarProvider>");
  return ctx;
}
