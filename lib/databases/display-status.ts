import { displayStatus, type RuntimeSnapshot } from "@/lib/apps/display-status";
import type { DatabaseStatus } from "@/lib/types/database";

// DatabaseDisplayStatus - what a database badge renders; the DB twin of displayStatus for apps.
export type DatabaseDisplayStatus =
  DatabaseStatus | "restarting" | "unhealthy" | "down";

export function databaseDisplayStatus(
  status: DatabaseStatus,
  runtime: RuntimeSnapshot | null | undefined,
): DatabaseDisplayStatus {
  // Only "running" is a claim about the host worth refuting; provisioning/stopped/error are control-plane facts.
  if (status !== "running") return status;
  // The app fold speaks the app enum: running is its "active".
  const folded = displayStatus("active", runtime);
  switch (folded) {
    case "active":
      return "running";
    case "restarting":
      return "restarting";
    case "unhealthy":
      return "unhealthy";
    case "down":
      return "down";
    default:
      return "running";
  }
}
