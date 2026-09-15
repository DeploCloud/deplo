"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";

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

export function useActiveDeployments(): number {
  return React.useContext(DeployActivityContext);
}
