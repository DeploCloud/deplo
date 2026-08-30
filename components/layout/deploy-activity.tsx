"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";

/**
 * How many builds the active team has in flight, live.
 */
const DeployActivityContext = React.createContext(0);

const ACTIVE_DEPLOYMENTS_SUBSCRIPTION = /* GraphQL */ `
  subscription ActiveDeployments {
    activeDeployments
  }
`;

export function DeployActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [count, setCount] = React.useState(0);

  React.useEffect(
    () =>
      gqlSubscribe<{ activeDeployments: number | null }>(
        ACTIVE_DEPLOYMENTS_SUBSCRIPTION,
        undefined,
        (data) => setCount(data.activeDeployments ?? 0),
        // A stream we can no longer open (signed out, team gone) simply stops
        // decorating the nav - never a toast about a decoration.
        () => setCount(0),
      ),
    [],
  );

  return (
    <DeployActivityContext.Provider value={count}>
      {children}
    </DeployActivityContext.Provider>
  );
}

/** Deployments queued or building right now, 0 when nothing is. */
export function useActiveDeployments(): number {
  return React.useContext(DeployActivityContext);
}
