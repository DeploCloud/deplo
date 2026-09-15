import { displayStatus, type RuntimeSnapshot } from "@/lib/apps/display-status";
import type { DatabaseStatus } from "@/lib/types/database";

export type DatabaseDisplayStatus =
  DatabaseStatus | "restarting" | "unhealthy" | "down";

export function databaseDisplayStatus(
  status: DatabaseStatus,
  runtime: RuntimeSnapshot | null | undefined,
): DatabaseDisplayStatus {
  if (status !== "running") return status;
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
