import type { App } from "../types/app";
import { supportsHealthStartInterval } from "./health-check";

// The agent starts the new version beside the old one and swaps only once it is ready.
export const OVERLAP_CAPABILITY = "deploy.overlap";

const BRIEFLY = "so it goes offline briefly while the new version starts.";

// The live stack the proxy waits on, and its stand-in; `ports` decides whether two can run at once.
export type OverlapStacks = {
  live: string;
  standIn: string;
  ports: App["ports"];
  // Above 1 the deploy always overlaps: it is never allowed to fall back to a swap in place.
  replicas: number;
};

export type DeployOverlap =
  { overlap: true } | { overlap: false; reason: string };

export function deployOverlap(opts: {
  ports: App["ports"];
  capabilities: readonly string[];
  dockerVersion?: string | null;
}): DeployOverlap {
  if ((opts.ports ?? []).length > 0)
    return {
      overlap: false,
      reason: `This app opens ports on the server, and two copies of it can't hold them at once, ${BRIEFLY}`,
    };
  if (!opts.capabilities.includes(OVERLAP_CAPABILITY))
    return {
      overlap: false,
      reason: `This server's agent is too old to keep the app online during a deploy, ${BRIEFLY} Deplo updates the agent on its own.`,
    };
  if (!supportsHealthStartInterval(opts.dockerVersion ?? undefined))
    return {
      overlap: false,
      reason: `This server's Docker is older than version 25, ${BRIEFLY}`,
    };
  return { overlap: true };
}
