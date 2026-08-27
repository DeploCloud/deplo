"use client";

import * as React from "react";

import { gqlAction } from "@/lib/graphql-client";

/** The release waiting upstream. */
export interface UpstreamUpdate {
  latest: string;
  current: string;
  url: string | null;
}

const UpdateContext = React.createContext<UpstreamUpdate | null>(null);

const UPDATE_QUERY = /* GraphQL */ `
  query UpstreamUpdate {
    updateInfo {
      updateAvailable
      latest
      current
      url
    }
  }
`;

type Info = {
  updateAvailable: boolean;
  latest: string | null;
  current: string;
  url: string | null;
};

/**
 * One check per dashboard load, shared: the banner announces it and the nav
 * marks it, off the same answer.
 */
export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const [update, setUpdate] = React.useState<UpstreamUpdate | null>(null);

  React.useEffect(() => {
    let active = true;
    void gqlAction<{ updateInfo: Info | null }, Info | null>(
      UPDATE_QUERY,
      undefined,
      (d) => d.updateInfo,
    ).then((res) => {
      if (!active || !res.ok || !res.data) return;
      const d = res.data;
      if (!d.updateAvailable || !d.latest) return;
      setUpdate({ latest: d.latest, current: d.current, url: d.url });
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <UpdateContext.Provider value={update}>{children}</UpdateContext.Provider>
  );
}

/**
 * The newer release upstream, or null when this instance is current. Deliberately
 * not the banner's dismissal: closing the banner hides the announcement, it does
 * not make the update go away.
 */
export function useUpstreamUpdate(): UpstreamUpdate | null {
  return React.useContext(UpdateContext);
}
