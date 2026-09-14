import type { AppStatus } from "@/lib/types/app";

// DisplayStatus is the status the UI renders, which is not the status we store.
export type DisplayStatus =
  AppStatus | "restarting" | "unhealthy" | "down" | "not_deployed";

// RuntimeSnapshot is the slice of AppRuntime the fold needs.
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
): DisplayStatus {
  if (neverDeployed && status === "idle") return "not_deployed";

  if (!runtime || runtime.unreachable) return status;

  if (status !== "active") return status;

  if (runtime.restarting > 0) return "restarting";
  if (runtime.running === 0) return "down";
  if (runtime.unhealthy > 0) return "unhealthy";
  return "active";
}
