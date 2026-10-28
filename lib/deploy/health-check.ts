import yaml from "../yaml";

import type { HealthCheck } from "../types/container";

export const HEALTH_CHECK_DEFAULTS = {
  intervalS: 30,
  timeoutS: 5,
  retries: 3,
  startPeriodS: 10,
} as const;

export function healthCheckToComposeKeys(
  h: HealthCheck | null | undefined,
): Record<string, unknown> {
  if (!h || h.type !== "command") return {};
  const test = h.command?.trim();
  if (!test) return {};
  return {
    healthcheck: {
      test: ["CMD-SHELL", test],
      interval: `${h.intervalS}s`,
      timeout: `${h.timeoutS}s`,
      retries: h.retries,
      start_period: `${h.startPeriodS}s`,
    },
  };
}

const START_PROBE_MS = 1_000;
const DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function durationMs(value: unknown): number | null {
  if (typeof value !== "string" || !DURATION.test(value.trim())) return null;
  let ms = 0;
  for (const [, n, unit] of value.trim().matchAll(DURATION_PART))
    ms += Number(n) * UNIT_MS[unit];
  return ms;
}

/** `healthcheck.start_interval` reaches the container from Docker Engine 25 on. */
export function supportsHealthStartInterval(dockerVersion?: string): boolean {
  return Number(dockerVersion?.split(".")[0]) >= 25;
}

// Docker probes every 5s during start_period unless told otherwise, and a
// `service_healthy` dependent waits on that probe. Once healthy, `interval` applies again.
export function probeEverySecondWhileStarting(
  svc: Record<string, unknown>,
): void {
  const hc = svc.healthcheck as Record<string, unknown> | undefined;
  if (!hc || typeof hc !== "object" || hc.disable === true) return;
  if (hc.start_interval !== undefined || hc.start_period === undefined) return;
  const interval = durationMs(hc.interval);
  hc.start_interval =
    interval !== null && interval > 0 && interval < START_PROBE_MS
      ? hc.interval
      : `${START_PROBE_MS / 1_000}s`;
}

export function renderYamlKeys(
  keys: Record<string, unknown>,
  indent: number,
): string {
  if (Object.keys(keys).length === 0) return "";
  const pad = " ".repeat(indent);
  return (
    yaml
      .dump(keys, { lineWidth: -1, noRefs: true })
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => pad + line)
      .join("\n") + "\n"
  );
}

export function renderHealthCheckYaml(
  h: HealthCheck | null | undefined,
  indent: number,
): string {
  return renderYamlKeys(healthCheckToComposeKeys(h), indent);
}
