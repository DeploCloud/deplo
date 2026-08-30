// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { DeploymentStatus } from "./types";

/**
 * Terminal deployment statuses - the build is over and the row will not change
 * again.
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
