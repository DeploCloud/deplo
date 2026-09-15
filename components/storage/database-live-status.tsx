"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { DatabaseStatus } from "@/lib/types/database";

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

export function useLiveDatabase(): LiveDatabase | null {
  return React.useContext(LiveDatabaseContext);
}

export function useLiveDatabaseStatus(
  fallback: DatabaseStatus,
): DatabaseStatus {
  return useLiveDatabase()?.status ?? fallback;
}
