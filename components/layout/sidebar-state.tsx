"use client";

import * as React from "react";

const COLLAPSE_KEY = "deplo:sidebar-collapsed";
const WIDTH_KEY = "deplo:sidebar-width";
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 240;

export const RAIL_WIDTH = 56;
const RAIL_AT = (RAIL_WIDTH + DEFAULT_WIDTH) / 2;
const SNAP_MS = 200;

export type SidebarMode = "expanded" | "rail";

// "hidden" and "1" are the fully hidden sidebar the rail replaced.
export function parseMode(raw: string | null): SidebarMode {
  return raw === "rail" || raw === "hidden" || raw === "1"
    ? "rail"
    : "expanded";
}

export const nextMode = (mode: SidebarMode): SidebarMode =>
  mode === "expanded" ? "rail" : "expanded";

const clampWidth = (n: number) =>
  Math.min(MAX_WIDTH, Math.max(DEFAULT_WIDTH, n));

export function resizeStep(clientX: number): {
  mode: SidebarMode;
  width: number;
  peek: number;
} {
  if (clientX >= DEFAULT_WIDTH)
    return { mode: "expanded", width: clampWidth(clientX), peek: 0 };
  if (clientX >= RAIL_AT)
    return {
      mode: "expanded",
      width: DEFAULT_WIDTH,
      peek: DEFAULT_WIDTH - clientX,
    };
  return { mode: "rail", width: DEFAULT_WIDTH, peek: 0 };
}

type SidebarState = {
  mode: SidebarMode;
  hydrated: boolean;
  width: number;
  dragging: boolean;
  // The width tracks the pointer with no transition; a snap animates.
  following: boolean;
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
  const [drag, setDrag] = React.useState({
    active: false,
    peek: 0,
    snapping: false,
  });
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

  const startResize = React.useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      endResize.current?.();
      let mode = state.mode;
      let snapTimer: ReturnType<typeof setTimeout> | undefined;
      setDrag({ active: true, peek: 0, snapping: false });

      function onMove(ev: PointerEvent) {
        const step = resizeStep(ev.clientX);
        widthRef.current = step.width;
        const snapped = step.mode !== mode;
        mode = step.mode;
        setState((prev) => ({ ...prev, mode: step.mode, width: step.width }));
        if (snapped) {
          clearTimeout(snapTimer);
          snapTimer = setTimeout(
            () => setDrag((d) => ({ ...d, snapping: false })),
            SNAP_MS,
          );
        }
        setDrag((d) => ({
          active: true,
          peek: step.peek,
          snapping: d.snapping || snapped,
        }));
      }
      function onUp() {
        clearTimeout(snapTimer);
        setDrag({ active: false, peek: 0, snapping: false });
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        if (endResize.current === onUp) endResize.current = null;
        try {
          window.localStorage.setItem(WIDTH_KEY, String(widthRef.current));
          window.localStorage.setItem(COLLAPSE_KEY, mode);
        } catch {}
      }
      endResize.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [state.mode],
  );

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
      following: drag.active && state.mode === "expanded" && !drag.snapping,
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
