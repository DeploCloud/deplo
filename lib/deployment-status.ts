import type { DeploymentStatus } from "./types";

/**
 * Terminal deployment statuses — the build is over and the row will not change
 * again. Everything else (`queued`, `building`) is still in flight.
 *
 * This module is deliberately dependency-free and client-safe: the server (the
 * boot reconcile) and the browser (the log stream, the live build timer) all
 * need the same answer to "is this build still running?", and three private
 * copies of the list is exactly how they drift apart.
 */
const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "ready",
  "error",
  "canceled",
]);

/** True while a deployment is still queued or building. */
export function isDeploymentLive(status: DeploymentStatus): boolean {
  return !TERMINAL.has(status);
}
