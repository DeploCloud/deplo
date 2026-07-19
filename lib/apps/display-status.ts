import type { AppStatus } from "@/lib/types";

/**
 * The status the UI actually renders, which is NOT the status we store.
 *
 * `apps.status` records the last thing the control plane was ASKED to do (deploy,
 * start, stop) — it is intent. A container that crash-loops five seconds after a
 * successful deploy leaves the row saying "active" forever, which is how an app in
 * a restart loop came to be reported as "Online". The runtime probe
 * (lib/data/console.ts getAppRuntime) reads what the host actually has; this
 * function folds the two into the one word we show.
 *
 * This is one of the TWO halves that keep the stored status honest, and they are
 * split by direction:
 *
 *  - DOWNWARD (here, live, never persisted). Only `active` is a claim ABOUT the
 *    host, so only `active` is worth contradicting — see the short-circuit below.
 *  - UPWARD (lib/data/app-status-reconcile.ts, persisted). `error` is terminal and
 *    self-sealing: this fold cannot clear it, and the runtime probe that would
 *    refute it is itself gated on `status === "active"`. So an App whose deploy
 *    failed while its previous stack kept serving stayed red forever. The
 *    telemetry stream now corrects that ONE transition (`error` -> `active`) on
 *    the row itself, which is also what fixes the readers that never had a live
 *    path at all (the Overview grid reads `apps.status` raw).
 *
 * The extra states beyond AppStatus are all runtime facts, never persisted:
 *  - `restarting` — docker is restart-looping the container (it keeps dying)
 *  - `degraded`   — part of a compose stack is up, part is not
 *  - `unhealthy`  — running, but failing its own healthcheck
 *  - `down`       — we believe the app is deployed and up, and nothing is running
 */
export type DisplayStatus =
  | AppStatus
  | "restarting"
  | "degraded"
  | "unhealthy"
  | "down";

/** The slice of {@link import("@/lib/data/console").AppRuntime} the fold needs. */
export interface RuntimeSnapshot {
  total: number;
  running: number;
  restarting: number;
  /** Running containers failing their healthcheck. */
  unhealthy: number;
  /** Declared services with no container on the host at all. */
  missing: string[];
  unreachable: boolean;
}

export function displayStatus(
  status: AppStatus,
  runtime: RuntimeSnapshot | null | undefined,
): DisplayStatus {
  // No probe, or the agent never answered: we do NOT know what the host is
  // doing. Say what we were told last and nothing more — inventing "down" from
  // an unreachable agent would trade one lie for another.
  if (!runtime || runtime.unreachable) return status;

  // Every other status is a control-plane fact the host cannot contradict: an
  // app mid-build has no container yet, a stopped one is meant to have none, a
  // failed deploy already says so. Only "active" is a claim ABOUT the host, and
  // only that claim is worth checking.
  if (status !== "active") return status;

  // A crash loop outranks everything: it is the loudest thing the host can be
  // telling us, and the reason this function exists.
  if (runtime.restarting > 0) return "restarting";
  // Nothing of the app is up: neither a container that is running, nor one that
  // could be. (An app whose containers are all missing lands here too.)
  if (runtime.running === 0) return "down";
  // Part of the app is up and part is not — including a service whose container
  // is missing entirely, which the running/total counts alone cannot see.
  if (runtime.running < runtime.total || runtime.missing.length > 0)
    return "degraded";
  // Everything is up, and something is failing its own healthcheck. Running is
  // not the same as working, and the app should not read green for this.
  if (runtime.unhealthy > 0) return "unhealthy";
  return "active";
}
