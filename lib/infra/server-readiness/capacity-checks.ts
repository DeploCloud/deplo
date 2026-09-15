import type { HostMetrics } from "../../agent/gen/agent";
import {
  READINESS_DETAILS,
  READINESS_HINTS,
  READINESS_MESSAGES,
} from "./messages";
import type { ReadinessCheck } from "./types";

export const DISK_WARN_PCT = 90;
export const DISK_FAIL_PCT = 95;

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

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(1)} GB`;
}
