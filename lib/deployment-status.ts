import type { DeploymentStatus } from "./types/deployment";

const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "ready",
  "error",
  "canceled",
]);

export function isDeploymentLive(status: DeploymentStatus): boolean {
  return !TERMINAL.has(status);
}
