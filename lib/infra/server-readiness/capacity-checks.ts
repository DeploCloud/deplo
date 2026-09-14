import type { HostMetrics } from "../../agent/gen/agent";
import {
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
} from "./messages";
import type { ReadinessCheck } from "./types";

/**
 * Disk thresholds, on the filesystem the AGENT measures, which the installer
 * points at `/` (the host's ROOT filesystem), not `/var/lib/docker`.
 */
export const DISK_WARN_PCT = 90;
export const DISK_FAIL_PCT = 95;

/** `diskTotal === 0` means the agent's statfs FAILED. It is not "0% used" - it is unknown. */
export function diskCheck(metrics: HostMetrics | null): ReadinessCheck {
  const base = {
    id: "capacity.disk",
    group: "capacity" as const,
    label: "Disk headroom",
  };
  if (!metrics)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.metricsUnavailable,
      hint: READINESS_HINTS.retry,
    };
  const total = Number(metrics.diskTotal);
  const used = Number(metrics.diskUsed);
  if (!Number.isFinite(total) || total <= 0)
    return {
      ...base,
      severity: "skip",
      detail: READINESS_MESSAGES.diskUnmeasured,
      hint: READINESS_HINTS.retry,
    };
  // ONE number, displayed and classified: classifying on the raw field while PRINTING the
  // fallback would render a 98%-full host as a green `pass` whose own text says it is 98% full.
  const rawPct = Number(metrics.diskPct);
  const pct = Math.floor(
    Number.isFinite(rawPct) && rawPct > 0 ? rawPct : (used / total) * 100,
  );
  const free = formatBytes(Math.max(0, total - used));
  if (pct >= DISK_FAIL_PCT)
    return {
      ...base,
      severity: "fail",
      detail: READINESS_DETAILS.diskCritical(pct, free),
      hint: READINESS_HINTS.freeDisk,
    };
  if (pct >= DISK_WARN_PCT)
    return {
      ...base,
      severity: "warn",
      detail: READINESS_DETAILS.diskLow(pct, free),
      hint: READINESS_HINTS.freeDisk,
    };
  return {
    ...base,
    severity: "pass",
    detail: READINESS_DETAILS.diskOk(pct, free),
  };
}

/** GB with one decimal. Exported for the tests that pin the disk copy. */
export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}
