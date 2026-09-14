import type { DeploymentStatus } from "./types/deployment";

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "ready",
  "error",
  "canceled",
]);

// isDeploymentLive - true while a deployment is still queued or building.
export function isDeploymentLive(status: DeploymentStatus): boolean {
  return !TERMINAL.has(status);
}
