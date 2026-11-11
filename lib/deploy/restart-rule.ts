import { RestartRule_Probe, type RestartRule } from "../agent/gen/agent";
import type { HealthCheck } from "../types/container";
import { servicesOf } from "./compose-lint/document";

// An app with a domain and no check of its own is asked for `/` on its port.
export const DEFAULT_RESTART_PROBE = {
  intervalS: 30,
  timeoutS: 10,
  retries: 3,
  startPeriodS: 60,
} as const;

// https://deplo.build/docs/guides/observability/health-checks
export function restartRuleFor(opts: {
  enabled: boolean;
  healthCheck: HealthCheck | null | undefined;
  // The routed port; portRequired is "the app has a domain".
  ready: { port: number; portRequired: boolean; service: string };
}): RestartRule | null {
  if (!opts.enabled) return null;
  const { healthCheck: h, ready } = opts;
  const base = { service: ready.service, port: 0, path: "", retries: 0 };
  if (h?.type === "command" && h.command?.trim())
    return {
      ...base,
      probe: RestartRule_Probe.PROBE_DOCKER_HEALTH,
      intervalS: h.intervalS,
      timeoutS: h.timeoutS,
      startPeriodS: h.startPeriodS,
    };
  if (h?.type === "http") {
    const port = h.port ?? ready.port;
    if (!port) return null;
    return {
      ...base,
      probe: RestartRule_Probe.PROBE_HTTP,
      port,
      path: h.path?.startsWith("/") ? h.path : "/",
      intervalS: h.intervalS,
      timeoutS: h.timeoutS,
      retries: h.retries,
      startPeriodS: h.startPeriodS,
    };
  }
  if (!ready.portRequired || ready.port <= 0) return null;
  return {
    ...base,
    probe: RestartRule_Probe.PROBE_HTTP,
    port: ready.port,
    path: "/",
    ...DEFAULT_RESTART_PROBE,
  };
}

const UNIT_S: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };

// Compose writes "1m30s"; anything else falls back to the default.
function seconds(v: unknown, fallback: number): number {
  let total = 0;
  for (const [, n, unit] of String(v ?? "").matchAll(/([\d.]+)(ms|h|m|s)/g))
    total += Number(n) * UNIT_S[unit];
  return total >= 1 ? Math.round(total) : fallback;
}

/** The `healthcheck:` a stack's service declares, as the command check it is; null when it has none or switched it off. */
export function composeHealthCheck(
  compose: string | null,
  service: string,
): HealthCheck | null {
  const svc = servicesOf(compose)?.[service] as
    { healthcheck?: Record<string, unknown> | null } | null | undefined;
  const h = svc?.healthcheck;
  if (!h || typeof h !== "object" || h.disable === true || h.test == null)
    return null;
  const test = Array.isArray(h.test) ? h.test.map(String) : [String(h.test)];
  if (test[0] === "NONE") return null;
  return {
    type: "command",
    path: null,
    port: null,
    command: test.join(" "),
    intervalS: seconds(h.interval, DEFAULT_RESTART_PROBE.intervalS),
    timeoutS: seconds(h.timeout, DEFAULT_RESTART_PROBE.timeoutS),
    retries: Number(h.retries) || DEFAULT_RESTART_PROBE.retries,
    startPeriodS: seconds(h.start_period, DEFAULT_RESTART_PROBE.startPeriodS),
  };
}
