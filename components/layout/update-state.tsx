"use client";

import * as React from "react";

import { gqlAction } from "@/lib/graphql-client";

// What Update installs: the newest release, or an update stop before it.
export interface UpstreamUpdate {
  next: string;
  current: string;
}

const UpdateContext = React.createContext<UpstreamUpdate | null>(null);

const UPDATE_QUERY = /* GraphQL */ `
  query UpstreamUpdate {
    updateInfo {
      updateAvailable
      next
      current
    }
  }
`;

type Info = {
  updateAvailable: boolean;
  next: string | null;
  current: string;
};

export function UpdateProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: React.ReactNode;
}) {
  const [update, setUpdate] = React.useState<UpstreamUpdate | null>(null);

  React.useEffect(() => {
    if (!enabled) return;
    let active = true;
    void gqlAction<{ updateInfo: Info | null }, Info | null>(
      UPDATE_QUERY,
      undefined,
      (d) => d.updateInfo,
    ).then((res) => {
      if (!active || !res.ok || !res.data) return;
      const d = res.data;
      if (!d.updateAvailable || !d.next) return;
      setUpdate({ next: d.next, current: d.current });
    });
    return () => {
      active = false;
    };
  }, [enabled]);

  return (
    <UpdateContext.Provider value={update}>{children}</UpdateContext.Provider>
  );
}

export function useUpstreamUpdate(): UpstreamUpdate | null {
  return React.useContext(UpdateContext);
}
