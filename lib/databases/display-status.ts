import { displayStatus, type RuntimeSnapshot } from "@/lib/apps/display-status";
import type { DatabaseStatus } from "@/lib/types";

/**
 * The status a database's badge actually renders — the DB twin of
 * {@link displayStatus} for apps. `databases.status` is intent (the last
 * lifecycle action the control plane took); only "running" is a claim about the
 * host, so only that claim is checked against the live runtime probe. A crash-
 * looping engine that the row still calls "running" reads as "restarting", a
 * partially-up state as "down"/"unhealthy" — never a false green.
 *
 * The extra states beyond DatabaseStatus are runtime facts, never persisted, and
 * share the app render vocabulary (StatusBadge knows their colours):
 *  - `restarting` — docker is restart-looping the container
 *  - `unhealthy`  — running but failing its own healthcheck
 *  - `down`       — believed running, nothing actually up
 */
export type DatabaseDisplayStatus =
  | DatabaseStatus
  | "restarting"
  | "unhealthy"
  | "down";

export function databaseDisplayStatus(
  status: DatabaseStatus,
  runtime: RuntimeSnapshot | null | undefined,
): DatabaseDisplayStatus {
  // Only "running" is a claim about the host worth refuting; provisioning /
  // stopped / error are control-plane facts the host can't contradict.
  if (status !== "running") return status;
  // Reuse the app fold by translating running → active. A single-container
  // database can't be "degraded" (that's a multi-service stack), so a stopped
  // or missing container folds to "down".
  const folded = displayStatus("active", runtime);
  switch (folded) {
    case "active":
      return "running";
    case "restarting":
      return "restarting";
    case "unhealthy":
      return "unhealthy";
    case "degraded":
    case "down":
      return "down";
    default:
      return "running";
  }
}
