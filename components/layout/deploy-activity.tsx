"use client";

import * as React from "react";
import { gqlSubscribe } from "@/lib/graphql-client";
import { useTeamPulse, type PulseKind } from "./team-pulse";

const DeployActivityContext = React.createContext(0);

const SHELL_PULSE_SUBSCRIPTION = /* GraphQL */ `
  subscription ShellPulse {
    shellPulse {
      activeDeployments
      changed
      changedBy
    }
  }
`;

type Pulse = {
  shellPulse: {
    activeDeployments: number | null;
    changed: PulseKind | null;
    changedBy: string | null;
  } | null;
};

// The shell's one stream: the deploy count for the sidebar, and the team's changes for the page cache.
export function DeployActivityProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [count, setCount] = React.useState(0);
  const pulse = useTeamPulse();

  React.useEffect(
    () =>
      gqlSubscribe<Pulse>(
        SHELL_PULSE_SUBSCRIPTION,
        undefined,
        (data) => {
          const p = data.shellPulse;
          if (!p) return;
          setCount(p.activeDeployments ?? 0);
          if (p.changed) pulse?.receive(p.changed, p.changedBy);
        },
        () => setCount(0),
      ),
    [pulse],
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
