"use client";

import * as React from "react";

const COLLAPSE_KEY = "deplo:sidebar-collapsed";
const WIDTH_KEY = "deplo:sidebar-width";
const MAX_WIDTH = 420;
// The default is also the floor: narrower than this the nav labels stop fitting.
const DEFAULT_WIDTH = 240;

// Past the floor the sidebar slides out instead of shrinking; two thirds hidden
// is where letting it go stops being a resize and becomes a close.
const CLOSE_AT = DEFAULT_WIDTH * 0.66;

const clampWidth = (n: number) =>
  Math.min(MAX_WIDTH, Math.max(DEFAULT_WIDTH, n));

/** One pointer position → resize, slide out, or snap shut. */
export function resizeStep(clientX: number) {
  if (clientX >= DEFAULT_WIDTH)
    return { width: clampWidth(clientX), peek: 0, close: false };
  const peek = DEFAULT_WIDTH - Math.max(0, clientX);
  return { width: DEFAULT_WIDTH, peek, close: peek >= CLOSE_AT };
}

type SidebarState = {
  collapsed: boolean;
  /** False until the persisted preference has been read, so nothing animates on first paint. */
  hydrated: boolean;
  width: number;
  dragging: boolean;
  /** How far the panel is slid off-screen mid-drag, in px. */
  peek: number;
  toggle: () => void;
  /** Pointer-drag on the sidebar's right edge; persists the width on release. */
  startResize: (e: React.PointerEvent) => void;
};

const SidebarContext = React.createContext<SidebarState | null>(null);

/**
 * Owns the desktop sidebar's collapsed flag and width. It lives above both the
 * sidebar and the topbar because the expand control sits in the topbar (the
 * sidebar itself collapses to zero width and has nowhere to host it).
 */
export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState({
    collapsed: false,
    hydrated: false,
    width: DEFAULT_WIDTH,
  });
  const [drag, setDrag] = React.useState({ active: false, peek: 0 });
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
    setState({
      collapsed: storedCollapsed,
      hydrated: true,
      width: storedWidth,
    });
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
    setDrag({ active: true, peek: 0 });

    function onMove(ev: PointerEvent) {
      const { width, peek, close } = resizeStep(ev.clientX);
      widthRef.current = width;
      setState((prev) => ({ ...prev, width }));
      if (close) finish(true);
      else setDrag({ active: true, peek });
    }
    // Dropping `dragging` re-enables the transition, so the last stretch of the
    // slide - back to the floor, or the rest of the way out - animates itself.
    function finish(close: boolean) {
      setDrag({ active: false, peek: 0 });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (close) setState((prev) => ({ ...prev, collapsed: true }));
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
        if (close) window.localStorage.setItem(COLLAPSE_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    function onUp() {
      finish(false);
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
    () => ({
      ...state,
      dragging: drag.active,
      peek: drag.peek,
      toggle,
      startResize,
    }),
    [state, drag, toggle, startResize],
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
