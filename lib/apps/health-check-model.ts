import type { HealthCheck } from "../types/container";
import { HEALTH_CHECK_DEFAULTS } from "../deploy/health-check";

export interface HealthCheckForm {
  enabled: boolean;
  type: "http" | "command";
  path: string;
  port: string;
  command: string;
  intervalS: string;
  timeoutS: string;
  retries: string;
  startPeriodS: string;
}

export const EMPTY_HEALTH_CHECK_FORM: HealthCheckForm = {
  enabled: false,
  type: "http",
  path: "/",
  port: "",
  command: "",
  intervalS: String(HEALTH_CHECK_DEFAULTS.intervalS),
  timeoutS: String(HEALTH_CHECK_DEFAULTS.timeoutS),
  retries: String(HEALTH_CHECK_DEFAULTS.retries),
  startPeriodS: String(HEALTH_CHECK_DEFAULTS.startPeriodS),
};

// healthCheckToForm maps the saved check to the editable form (null ⇒ defaults, off).
export function healthCheckToForm(h: HealthCheck | null): HealthCheckForm {
  if (!h) return { ...EMPTY_HEALTH_CHECK_FORM };
  return {
    enabled: true,
    type: h.type,
    path: h.path ?? "/",
    port: h.port == null ? "" : String(h.port),
    command: h.command ?? "",
    intervalS: String(h.intervalS),
    timeoutS: String(h.timeoutS),
    retries: String(h.retries),
    startPeriodS: String(h.startPeriodS),
  };
}

function num(v: string, fallback: number, min: number, max: number): number {
  const n = Number(v.trim());
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// healthCheckFromForm is what a save sends, or null when the switch is off.
export function healthCheckFromForm(f: HealthCheckForm): HealthCheck | null {
  if (!f.enabled) return null;
  const port = f.port.trim() ? num(f.port, 0, 1, 65535) : null;
  return {
    type: f.type,
    path: f.type === "http" ? f.path.trim() || "/" : null,
    port: f.type === "http" ? port : null,
    command: f.type === "command" ? f.command.trim() || null : null,
    intervalS: num(f.intervalS, HEALTH_CHECK_DEFAULTS.intervalS, 1, 86_400),
    timeoutS: num(f.timeoutS, HEALTH_CHECK_DEFAULTS.timeoutS, 1, 3_600),
    retries: num(f.retries, HEALTH_CHECK_DEFAULTS.retries, 1, 100),
    startPeriodS: num(
      f.startPeriodS,
      HEALTH_CHECK_DEFAULTS.startPeriodS,
      0,
      86_400,
    ),
  };
}

// healthCheckProblem is why this check cannot be saved, or null.
export function healthCheckProblem(h: HealthCheck | null): string | null {
  if (!h) return null;
  if (h.type === "command" && !h.command?.trim())
    return "Give the command to run, or switch the check to HTTP.";
  if (h.type === "http" && h.path != null && !h.path.startsWith("/"))
    return "The path has to start with a slash.";
  if (h.timeoutS >= h.intervalS)
    return "The timeout has to be shorter than the interval, or a slow check never finishes before the next one starts.";
  return null;
}
