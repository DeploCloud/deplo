"use client";

import * as React from "react";

import { gqlAction } from "@/lib/graphql-client";

// What Update installs (the newest release, or an update stop before it), and a security fix this instance lacks.
export interface UpstreamUpdate {
  next: string | null;
  current: string;
  securityFix: string | null;
}

const UpdateContext = React.createContext<UpstreamUpdate | null>(null);

const UPDATE_QUERY = /* GraphQL */ `
  query UpstreamUpdate {
    updateInfo {
      updateAvailable
      next
      current
      securityFix
    }
  }
`;

type Info = {
  updateAvailable: boolean;
  next: string | null;
  current: string;
  securityFix: string | null;
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
      const next = d.updateAvailable ? d.next : null;
      if (!next && !d.securityFix) return;
      setUpdate({ next, current: d.current, securityFix: d.securityFix });
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
