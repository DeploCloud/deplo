"use client";

import * as React from "react";

const COLLAPSE_KEY = "deplo:sidebar-collapsed";
const WIDTH_KEY = "deplo:sidebar-width";
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;

const CLOSE_AT = DEFAULT_WIDTH * 0.66;

export const RAIL_WIDTH = 56;

export type SidebarMode = "expanded" | "rail" | "hidden";

// "1" is what the old collapse switch stored: the sidebar was fully hidden.
export function parseMode(raw: string | null): SidebarMode {
  if (raw === "rail") return "rail";
  return raw === "hidden" || raw === "1" ? "hidden" : "expanded";
}

export const nextMode = (mode: SidebarMode): SidebarMode =>
  mode === "expanded" ? "rail" : "expanded";

const clampWidth = (n: number) =>
  Math.min(MAX_WIDTH, Math.max(DEFAULT_WIDTH, n));

export function resizeStep(clientX: number) {
  if (clientX >= DEFAULT_WIDTH)
    return { width: clampWidth(clientX), peek: 0, close: false };
  const peek = DEFAULT_WIDTH - Math.max(0, clientX);
  return { width: DEFAULT_WIDTH, peek, close: peek >= CLOSE_AT };
}

type SidebarState = {
  mode: SidebarMode;
  hydrated: boolean;
  width: number;
  dragging: boolean;
  peek: number;
  toggle: () => void;
  startResize: (e: React.PointerEvent) => void;
  resetWidth: () => void;
};

const SidebarContext = React.createContext<SidebarState | null>(null);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState({
    mode: "expanded" as SidebarMode,
    hydrated: false,
    width: DEFAULT_WIDTH,
  });
  const [drag, setDrag] = React.useState({ active: false, peek: 0 });
  const widthRef = React.useRef(DEFAULT_WIDTH);

  React.useEffect(() => {
    let storedMode: SidebarMode = "expanded";
    let storedWidth = DEFAULT_WIDTH;
    try {
      storedMode = parseMode(window.localStorage.getItem(COLLAPSE_KEY));
      const w = Number(window.localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(w) && w > 0) storedWidth = clampWidth(w);
    } catch {}
    widthRef.current = storedWidth;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- apply persisted UI preference after mount
    setState({
      mode: storedMode,
      hydrated: true,
      width: storedWidth,
    });
  }, []);

  const toggle = React.useCallback(() => {
    setState((prev) => {
      const mode = nextMode(prev.mode);
      try {
        window.localStorage.setItem(COLLAPSE_KEY, mode);
      } catch {}
      return { ...prev, mode };
    });
  }, []);

  const resetWidth = React.useCallback(() => {
    widthRef.current = DEFAULT_WIDTH;
    setState((prev) => ({ ...prev, width: DEFAULT_WIDTH }));
    try {
      window.localStorage.setItem(WIDTH_KEY, String(DEFAULT_WIDTH));
    } catch {}
  }, []);

  const endResize = React.useRef<(() => void) | null>(null);

  const startResize = React.useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    endResize.current?.();
    setDrag({ active: true, peek: 0 });

    function onMove(ev: PointerEvent) {
      const { width, peek, close } = resizeStep(ev.clientX);
      widthRef.current = width;
      setState((prev) => ({ ...prev, width }));
      if (close) finish(true);
      else setDrag({ active: true, peek });
    }
    function finish(close: boolean) {
      setDrag({ active: false, peek: 0 });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (endResize.current === onUp) endResize.current = null;
      if (close) setState((prev) => ({ ...prev, mode: "hidden" }));
      try {
        window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
        if (close) window.localStorage.setItem(COLLAPSE_KEY, "hidden");
      } catch {}
    }
    function onUp() {
      finish(false);
    }
    endResize.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  React.useEffect(() => () => endResize.current?.(), []);

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
      resetWidth,
    }),
    [state, drag, toggle, startResize, resetWidth],
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
