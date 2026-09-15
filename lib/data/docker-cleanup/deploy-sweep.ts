import "server-only";

import { runAgentCleanup } from "../../infra/agent-client/docker-cleanup";
import { rollbackKeepBySlug } from "./live-inventory";
import { loadPolicy } from "./policy";
import { listServersWithCleanupRunning } from "./run-history";
import { deploySweepScopes } from "./scopes";

const deploySweepInFlight = new Set<string>();

export function serversWithDeploySweepInFlight(): string[] {
  return [...deploySweepInFlight];
}

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
    if ((await listServersWithCleanupRunning()).includes(serverId)) return 0;

    const resp = await runAgentCleanup(serverId, {
      scopes,
      dryRun: false,
      minAgeHours: policy.minAgeHours,
      keepImagesPerApp: policy.keepImagesPerApp,
      keepPerSlug: await rollbackKeepBySlug(serverId),
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
