"use client";

import * as React from "react";

import { ConfettiBurst } from "@/components/shared/confetti-burst";
import { isDeploymentLive } from "@/lib/deployment-status";
import type { DeploymentStatus } from "@/lib/types";

/** How long the two cannons hold the screen. */
const SHOW_MS = 4000;

/**
 * What an app's first build earns when it lands. It fires on the TRANSITION
 * only, so opening a finished deployment later is just the page.
 */
export function FirstDeployCelebration({
  status,
}: {
  status: DeploymentStatus;
}) {
  // The status this page was OPENED on, kept across the poll's refreshes.
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
