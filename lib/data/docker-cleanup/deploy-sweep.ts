import "server-only";

import { runAgentCleanup } from "../../infra/agent-client/docker-cleanup";
import { rollbackKeepBySlug } from "./live-inventory";
import { loadPolicy } from "./policy";
import { listServersWithCleanupRunning } from "./run-history";
import { deploySweepScopes } from "./scopes";

/** Servers with a deploy-triggered sweep in flight - a second one would only race the
 *  first's candidate list; the next deploy catches anything it missed. */
const deploySweepInFlight = new Set<string>();

/**
 * Snapshot of {@link deploySweepInFlight}, for the scheduler's never-stack-sweeps
 * check: the deploy-time sweep writes NO run row on purpose, so without this
 * in-process signal a tick could start a scheduled sweep on a host mid-sweep.
 */
export function serversWithDeploySweepInFlight(): string[] {
  return [...deploySweepInFlight];
}

/**
 * Remove what a deploy just left on `serverId`: superseded app images and build
 * cache past the host's ceiling, NOW rather than at the nightly sweep - a day of
 * builds can fill a disk before 04:00. Never the leftover scopes.
 */
export async function sweepSupersededAppImages(
  serverId: string,
): Promise<number> {
  if (deploySweepInFlight.has(serverId)) return 0;
  deploySweepInFlight.add(serverId);
  try {
    const policy = await loadPolicy();
    const scopes = deploySweepScopes(policy.scopes);
    if (scopes.length === 0) return 0;
    if (policy.excludedServerIds.includes(serverId)) return 0;
    // A full sweep already running on this host will get there itself.
    if ((await listServersWithCleanupRunning()).includes(serverId)) return 0;

    const resp = await runAgentCleanup(serverId, {
      scopes,
      dryRun: false,
      // The cache scope's age filter; the images scope is count-based.
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      // THE sweep that decides whether a rollback is possible: it runs right after the
      // deploy that superseded the previous image, so the instance scalar instead of
      // the app's own depth would drop the rollback target before anybody could use it.
      keepPerSlug: await rollbackKeepBySlug(serverId),
      // No inventory: a deleted app's images are the schedule's business.
      liveSlugs: [],
      liveNetworks: [],
    });
    if (!resp.ok) {
      console.warn(
        `[cleanup] deploy-time image sweep on ${serverId} failed: ${resp.error || "unknown"}`,
      );
      return 0;
    }
    return Number(resp.reclaimedBytes ?? 0);
  } catch (e) {
    console.warn(
      `[cleanup] deploy-time image sweep on ${serverId} failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return 0;
  } finally {
    deploySweepInFlight.delete(serverId);
  }
}
