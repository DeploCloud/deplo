// https://deplo.build/docs/advanced/resource-limits

import yaml from "../yaml";

import type { ResourceLimits } from "../types";

/**
 * Per-app resource limits → the `docker compose up` service keys that ENFORCE
 * them.
 */
export function resourceLimitsToComposeKeys(
  r: ResourceLimits | null | undefined,
): Record<string, unknown> {
  if (!r) return {};
  const out: Record<string, unknown> = {};
  if (r.memoryMb != null) out.mem_limit = `${r.memoryMb}m`;
  if (r.memoryReservationMb != null)
    out.mem_reservation = `${r.memoryReservationMb}m`;
  if (r.swapMb != null) out.memswap_limit = `${r.swapMb}m`;
  if (r.cpuMilli != null) out.cpus = milliToCpuString(r.cpuMilli);
  if (r.cpuShares != null) out.cpu_shares = r.cpuShares;
  if (r.cpuset != null) out.cpuset = r.cpuset;
  if (r.pidsLimit != null) out.pids_limit = r.pidsLimit;
  if (r.shmSizeMb != null) out.shm_size = `${r.shmSizeMb}m`;
  if (r.storageGb != null) out.storage_opt = { size: `${r.storageGb}G` };
  // `ulimits` is a nested map; emit it only when at least one sub-limit is set.
  const ulimits: Record<string, number> = {};
  if (r.nofile != null) ulimits.nofile = r.nofile;
  if (r.nproc != null) ulimits.nproc = r.nproc;
  if (Object.keys(ulimits).length > 0) out.ulimits = ulimits;
  if (r.oomScoreAdj != null) out.oom_score_adj = r.oomScoreAdj;
  return out;
}

/**
 * Render the resource-limit keys as a YAML FRAGMENT indented `indent` spaces - for
 * the string-built single-image path (`renderCompose`), which has no service
 * object to mutate.
 */
export function renderResourceLimitsYaml(
  r: ResourceLimits | null | undefined,
  indent: number,
): string {
  const keys = resourceLimitsToComposeKeys(r);
  if (Object.keys(keys).length === 0) return "";
  const pad = " ".repeat(indent);
  const dumped = yaml.dump(keys, { lineWidth: -1, noRefs: true });
  return (
    dumped
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => pad + line)
      .join("\n") + "\n"
  );
}

/**
 * Overlay resource-limit keys onto a compose-stack service, EXISTING-WINS: a key
 * the service already declares in its own compose is never overridden.
 */
export function mergeResourceLimits(
  svc: Record<string, unknown>,
  r: ResourceLimits | null | undefined,
): void {
  const keys = resourceLimitsToComposeKeys(r);
  for (const [k, v] of Object.entries(keys)) {
    if (!(k in svc)) svc[k] = v;
  }
}

/** milli-CPUs → the fractional-core string compose wants (`500` → "0.5", `2000` → "2"). */
function milliToCpuString(milli: number): string {
  return String(milli / 1000);
}
