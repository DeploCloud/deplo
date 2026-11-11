import { RestartRule_Probe, type RestartRule } from "../agent/gen/agent";
import type { HealthCheck } from "../types/container";

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
  // Only the App's own http check fails on an error status; the default takes any answer as alive.
  const base = {
    service: ready.service,
    port: 0,
    path: "",
    retries: 0,
    failOnErrorStatus: false,
  };
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
      failOnErrorStatus: true,
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
