"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { DatabaseStatus } from "@/lib/types";

/**
 * The live, client-tracked slice of a database's state — the DB twin of
 * {@link import("@/components/apps/app-live-status").AppLiveStatusProvider}.
 * Seeded from the server render, kept current by the databaseStatus
 * subscription so the header badge, controls and gated pages react to
 * provisioning → running, start/stop and redeploy across every client without
 * a reload.
 */
export type LiveDatabase = {
  id: string;
  name: string;
  status: DatabaseStatus;
};

const DATABASE_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription DatabaseStatus($id: String!) {
    databaseStatus(id: $id) {
      id
      name
      status
    }
  }
`;

type SubResult = {
  databaseStatus: { id: string; name: string; status: DatabaseStatus } | null;
};

const LiveDatabaseContext = React.createContext<LiveDatabase | null>(null);

export function DatabaseLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveDatabase;
  children: React.ReactNode;
}) {
  // Keyed by id in the layout, so it remounts (and re-seeds) on navigation.
  const [live, setLive] = React.useState<LiveDatabase>(initial);

  React.useEffect(() => {
    const unsubscribe = gqlSubscribe<SubResult>(
      DATABASE_STATUS_SUBSCRIPTION,
      { id: initial.id },
      (data) => {
        const d = data.databaseStatus;
        if (!d) return;
        setLive({ id: d.id, name: d.name, status: d.status });
      },
    );
    return unsubscribe;
  }, [initial.id]);

  return (
    <LiveDatabaseContext.Provider value={live}>
      {children}
    </LiveDatabaseContext.Provider>
  );
}

/** Read the live database state, or null outside a provider. */
export function useLiveDatabase(): LiveDatabase | null {
  return React.useContext(LiveDatabaseContext);
}

/** The database's live status, falling back to a server-rendered value. */
export function useLiveDatabaseStatus(fallback: DatabaseStatus): DatabaseStatus {
  return useLiveDatabase()?.status ?? fallback;
}
