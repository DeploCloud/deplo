"use client";

import * as React from "react";

import { gqlAction } from "@/lib/graphql-client";

/** The release waiting upstream. */
export interface UpstreamUpdate {
  latest: string;
  current: string;
}

const UpdateContext = React.createContext<UpstreamUpdate | null>(null);

const UPDATE_QUERY = /* GraphQL */ `
  query UpstreamUpdate {
    updateInfo {
      updateAvailable
      latest
      current
    }
  }
`;

type Info = {
  updateAvailable: boolean;
  latest: string | null;
  current: string;
};

/**
 * One check per dashboard load, shared: the topbar chip announces it and the nav
 * marks it, off the same answer. Only for an instance admin: nobody else can
 * apply an update, and Settings -> Deplo, where it is applied, is theirs alone.
 */
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
      if (!d.updateAvailable || !d.latest) return;
      setUpdate({ latest: d.latest, current: d.current });
    });
    return () => {
      active = false;
    };
  }, [enabled]);

  return (
    <UpdateContext.Provider value={update}>{children}</UpdateContext.Provider>
  );
}

/**
 * The newer release upstream, or null when this instance is current.
 */
export function useUpstreamUpdate(): UpstreamUpdate | null {
  return React.useContext(UpdateContext);
}
