"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import type { DatabaseStatus } from "@/lib/types/database";

export type LiveDatabase = {
  id: string;
  name: string;
  status: DatabaseStatus;
  restartLoopStoppedAt: string | null;
};

const DATABASE_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription DatabaseStatus($id: String!) {
    databaseStatus(id: $id) {
      id
      name
      status
      restartLoopStoppedAt
    }
  }
`;

type SubResult = {
  databaseStatus: {
    id: string;
    name: string;
    status: DatabaseStatus;
    restartLoopStoppedAt: string | null;
  } | null;
};

const DATABASES_STATUS_SUBSCRIPTION = /* GraphQL */ `
  subscription DatabasesStatus($ids: [String!]!) {
    databasesStatus(ids: $ids) {
      id
      name
      status
      restartLoopStoppedAt
    }
  }
`;

const LiveDatabaseContext = React.createContext<LiveDatabase | null>(null);
const LiveDatabaseListContext = React.createContext<ReadonlyMap<
  string,
  LiveDatabase
> | null>(null);

// One stream for every card in a list: a stream per card filled the browser's six HTTP/1.1 connections.
export function DatabaseListLiveStatusProvider({
  ids,
  children,
}: {
  ids: readonly string[];
  children: React.ReactNode;
}) {
  const [byId, setById] = React.useState<ReadonlyMap<string, LiveDatabase>>(
    () => new Map(),
  );
  const key = [...ids].sort().join(",");

  React.useEffect(() => {
    if (!key) return;
    return gqlSubscribe<{ databasesStatus: LiveDatabase | null }>(
      DATABASES_STATUS_SUBSCRIPTION,
      { ids: key.split(",") },
      (data) => {
        const d = data.databasesStatus;
        if (!d) return;
        setById((prev) =>
          new Map(prev).set(d.id, {
            id: d.id,
            name: d.name,
            status: d.status,
            restartLoopStoppedAt: d.restartLoopStoppedAt,
          }),
        );
      },
    );
  }, [key]);

  return (
    <LiveDatabaseListContext.Provider value={byId}>
      {children}
    </LiveDatabaseListContext.Provider>
  );
}

export function DatabaseLiveStatusProvider({
  initial,
  children,
}: {
  initial: LiveDatabase;
  children: React.ReactNode;
}) {
  const list = React.useContext(LiveDatabaseListContext);
  const inList = list !== null;
  const [own, setLive] = React.useState<LiveDatabase>(initial);
  const live = (inList ? list.get(initial.id) : own) ?? initial;

  React.useEffect(() => {
    if (inList) return;
    const unsubscribe = gqlSubscribe<SubResult>(
      DATABASE_STATUS_SUBSCRIPTION,
      { id: initial.id },
      (data) => {
        const d = data.databaseStatus;
        if (!d) return;
        setLive({
          id: d.id,
          name: d.name,
          status: d.status,
          restartLoopStoppedAt: d.restartLoopStoppedAt,
        });
      },
    );
    return unsubscribe;
  }, [initial.id, inList]);

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
