// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { AppStatus } from "@/lib/types";

/**
 * The status the UI actually renders, which is NOT the status we store. This is
 * one of the TWO halves that keep the stored status honest, and they are split by
 * direction: - DOWNWARD (here, live, never persisted).
 */
export type DisplayStatus =
  AppStatus | "restarting" | "degraded" | "unhealthy" | "down" | "not_deployed";

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
  /** This app has no deployment at all - see {@link DisplayStatus}. */
  neverDeployed?: boolean,
): DisplayStatus {
  // Never built, so never running: "Stopped" would claim somebody stopped it, and the
  // only control that makes sense is a first deploy.
  if (neverDeployed && status === "idle") return "not_deployed";

  // No probe, or the agent never answered: we do NOT know what the host is
  // doing. Say what we were told last and nothing more - inventing "down" from
  // an unreachable agent would trade one lie for another.
  if (!runtime || runtime.unreachable) return status;

  // Every other status is a control-plane fact the host cannot contradict: an app
  // mid-build has no container yet, a stopped one is meant to have none, a failed
  // deploy already says so.
  if (status !== "active") return status;

  // A crash loop outranks everything: it is the loudest thing the host can be
  // telling us, and the reason this function exists.
  if (runtime.restarting > 0) return "restarting";
  // Nothing of the app is up: neither a container that is running, nor one that
  // could be. (An app whose containers are all missing lands here too.)
  if (runtime.running === 0) return "down";
  // Part of the app is up and part is not, including a service whose container
  // is missing entirely, which the running/total counts alone cannot see.
  if (runtime.running < runtime.total || runtime.missing.length > 0)
    return "degraded";
  // Everything is up, and something is failing its own healthcheck. Running is
  // not the same as working, and the app should not read green for this.
  if (runtime.unhealthy > 0) return "unhealthy";
  return "active";
}
