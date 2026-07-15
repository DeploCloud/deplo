import yaml from "js-yaml";

import type { ResourceLimits } from "../types";

/**
 * Per-app resource limits → the `docker compose up` service keys that ENFORCE
 * them. deplo's agent brings every stack up with `docker compose up` (never
 * `docker stack deploy`), so the enforced form is the top-level, non-swarm
 * container keys (`mem_limit` / `cpus` / `pids_limit` / …) — the swarm-only
 * `deploy.resources.*` block is silently ignored by `compose up` and is NOT
 * used here.
 *
 * A `null` limits object — or one whose every field is unset — yields `{}`, so
 * the rendered service is byte-identical to the historical one (the same
 * byte-identical-stack contract volumes/env injection preserve: an app with no
 * limits never restarts on a reroute).
 *
 * Stored units → compose units: memory MiB → `<n>m`, disk GiB → `<n>G`, CPU
 * milli-CPUs → a fractional-core string (`500` → `"0.5"`). Kept as one pure
 * function so the single-image path, the compose-stack path, and the tests all
 * agree on exactly one mapping.
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
 * Render the resource-limit keys as a YAML FRAGMENT indented `indent` spaces —
 * for the string-built single-image path (`renderCompose`), which has no service
 * object to mutate. Empty string when there are no limits, so the fragment drops
 * out of the template and the stack stays byte-identical. We dump the same keys
 * object with `js-yaml` (rather than hand-format the nested `ulimits`/
 * `storage_opt` maps) so the fragment can never disagree with the object form.
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
 * the service already declares in its own compose is never overridden. This
 * mirrors the env-injection precedence (`mergeEnvironment`) — the user's own
 * compose is authoritative — and applies the app-level cap to every service that
 * hasn't set its own. Empty keys ⇒ the service is left untouched (byte-identical).
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
