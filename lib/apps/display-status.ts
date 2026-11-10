import type { AppStatus } from "@/lib/types/app";

export type DisplayStatus =
  | AppStatus
  | "restarting"
  | "unhealthy"
  | "unresponsive"
  | "down"
  | "not_deployed";

export interface RuntimeSnapshot {
  total: number;
  running: number;
  restarting: number;
  unhealthy: number;
  missing: string[];
  unreachable: boolean;
}

export function displayStatus(
  status: AppStatus,
  runtime: RuntimeSnapshot | null | undefined,
  neverDeployed?: boolean,
  restartsPaused?: boolean,
): DisplayStatus {
  if (neverDeployed && status === "idle") return "not_deployed";

  const paused = status === "active" && !!restartsPaused;
  if (!runtime || runtime.unreachable) return paused ? "unresponsive" : status;

  if (status !== "active") return status;

  if (runtime.restarting > 0) return "restarting";
  if (runtime.running === 0) return "down";
  if (paused) return "unresponsive";
  if (runtime.unhealthy > 0) return "unhealthy";
  return "active";
}
