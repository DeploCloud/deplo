import type { AppStatus } from "@/lib/types/app";

/** The start of an App's offline reason while no server of its cluster answers Deplo. */
export const OUT_OF_REACH = "Offline: Deplo cannot reach its cluster";

export type DisplayStatus =
  | AppStatus
  | "restarting"
  | "unhealthy"
  | "unresponsive"
  | "down"
  | "unreachable"
  | "moving"
  | "not_deployed";

export interface RuntimeSnapshot {
  total: number;
  running: number;
  restarting: number;
  unhealthy: number;
  missing: string[];
  unreachable: boolean;
  /** A cluster moving the App: the new server's name, and since when. */
  moveTo?: string | null;
  moveSince?: string | null;
  /** Why an offline cluster App cannot move. */
  offlineWhy?: string | null;
}

export function displayStatus(
  status: AppStatus,
  runtime: RuntimeSnapshot | null | undefined,
  neverDeployed?: boolean,
  restartsPaused?: boolean,
): DisplayStatus {
  if (neverDeployed && status === "idle") return "not_deployed";

  const paused = status === "active" && !!restartsPaused;
  if (runtime?.moveTo && status === "active") return "moving";
  // A server that does not answer says nothing about its Apps: never show the last state as live.
  if (runtime?.unreachable && status === "active") return "unreachable";
  if (!runtime || runtime.unreachable) return paused ? "unresponsive" : status;

  if (status !== "active") return status;

  if (runtime.restarting > 0) return "restarting";
  if (runtime.running === 0) return "down";
  if (paused) return "unresponsive";
  if (runtime.unhealthy > 0) return "unhealthy";
  return "active";
}

/** "Moving to eu-2 · 34 s" while a cluster moves the App, or why it cannot move; null otherwise. */
export function moveLabel(
  runtime: RuntimeSnapshot | null | undefined,
  now = Date.now(),
): string | null {
  if (runtime?.moveTo) {
    const s = Math.max(
      0,
      Math.round((now - Date.parse(runtime.moveSince ?? "")) / 1000),
    );
    const took = Number.isFinite(s)
      ? s < 60
        ? `${s} s`
        : `${Math.floor(s / 60)} min ${s % 60} s`
      : "";
    return took
      ? `Moving to ${runtime.moveTo} · ${took}`
      : `Moving to ${runtime.moveTo}`;
  }
  return runtime?.unreachable && runtime.offlineWhy ? runtime.offlineWhy : null;
}
