// https://deplo.build/docs/advanced/resource-limits

import yaml from "../yaml";

import type { ResourceLimits } from "../types/container";

// Per-app resource limits → the `docker compose up` service keys that enforce them.
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
  const ulimits: Record<string, number> = {};
  if (r.nofile != null) ulimits.nofile = r.nofile;
  if (r.nproc != null) ulimits.nproc = r.nproc;
  if (Object.keys(ulimits).length > 0) out.ulimits = ulimits;
  if (r.oomScoreAdj != null) out.oom_score_adj = r.oomScoreAdj;
  return out;
}

// The resource-limit keys as a YAML fragment indented `indent` spaces, for the string-built renderCompose path.
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

// Overlay resource-limit keys onto a compose-stack service, existing-wins: its own compose keys are never overridden.
export function mergeResourceLimits(
  svc: Record<string, unknown>,
  r: ResourceLimits | null | undefined,
): void {
  const keys = resourceLimitsToComposeKeys(r);
  for (const [k, v] of Object.entries(keys)) {
    if (!(k in svc)) svc[k] = v;
  }
}

function milliToCpuString(milli: number): string {
  return String(milli / 1000);
}
