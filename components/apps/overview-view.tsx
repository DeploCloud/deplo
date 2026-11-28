"use client";

import * as React from "react";
import type { ListView } from "@/components/shared/view-toggle";

const ViewContext = React.createContext<{
  view: ListView;
  setView: (view: ListView) => void;
} | null>(null);

// The click switches the layout at once; the URL, and the server's answer to it, follow.
export function OverviewViewProvider({
  initial,
  children,
}: {
  initial: ListView;
  children: React.ReactNode;
}) {
  const [state, setState] = React.useState({ initial, view: initial });
  if (state.initial !== initial) setState({ initial, view: initial });
  const setView = React.useCallback(
    (view: ListView) => setState((s) => ({ ...s, view })),
    [],
  );
  const value = React.useMemo(
    () => ({ view: state.initial === initial ? state.view : initial, setView }),
    [state, initial, setView],
  );
  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>;
}

export function useOverviewView(fallback: ListView) {
  return React.useContext(ViewContext) ?? { view: fallback, setView: () => {} };
}
