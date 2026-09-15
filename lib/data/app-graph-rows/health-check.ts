import "server-only";

import { HEALTH_CHECK_DEFAULTS } from "../../deploy/health-check";
import type { HealthCheck } from "../../types/container";

export function assembleHealthCheck(row: {
  healthCheckEnabled: boolean;
  healthCheckType: string | null;
  healthCheckPath: string | null;
  healthCheckPort: number | null;
  healthCheckCommand: string | null;
  healthCheckIntervalS: number | null;
  healthCheckTimeoutS: number | null;
  healthCheckRetries: number | null;
  healthCheckStartPeriodS: number | null;
}): HealthCheck | null {
  if (!row.healthCheckEnabled) return null;
  return {
    type: row.healthCheckType === "command" ? "command" : "http",
    path: row.healthCheckPath,
    port: row.healthCheckPort,
    command: row.healthCheckCommand,
    intervalS: row.healthCheckIntervalS ?? HEALTH_CHECK_DEFAULTS.intervalS,
    timeoutS: row.healthCheckTimeoutS ?? HEALTH_CHECK_DEFAULTS.timeoutS,
    retries: row.healthCheckRetries ?? HEALTH_CHECK_DEFAULTS.retries,
    startPeriodS:
      row.healthCheckStartPeriodS ?? HEALTH_CHECK_DEFAULTS.startPeriodS,
  };
}

export function healthCheckToRow(h: HealthCheck | null) {
  return {
    healthCheckEnabled: h != null,
    healthCheckType: h?.type ?? null,
    healthCheckPath: h?.path ?? null,
    healthCheckPort: h?.port ?? null,
    healthCheckCommand: h?.command ?? null,
    healthCheckIntervalS: h?.intervalS ?? null,
    healthCheckTimeoutS: h?.timeoutS ?? null,
    healthCheckRetries: h?.retries ?? null,
    healthCheckStartPeriodS: h?.startPeriodS ?? null,
  };
}
