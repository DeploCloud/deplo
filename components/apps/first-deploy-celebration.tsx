"use client";

import * as React from "react";

import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { isDeploymentLive } from "@/lib/deployment-status";
import type { DeploymentStatus } from "@/lib/types/deployment";

const SHOW_MS = 4000;

export function FirstDeployCelebration({
  status,
}: {
  status: DeploymentStatus;
}) {
  const [watched] = React.useState(() => isDeploymentLive(status));
  const [done, setDone] = React.useState(false);
  const fire = watched && status === "ready" && !done;

  React.useEffect(() => {
    if (!fire) return;
    const timer = setTimeout(() => setDone(true), SHOW_MS);
    return () => clearTimeout(timer);
  }, [fire]);

  if (!fire) return null;
  return <ConfettiBurst cannons count={64} className="z-50" />;
}
