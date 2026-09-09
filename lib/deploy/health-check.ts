// https://deplo.build/docs/guides/observability/monitoring

import yaml from "../yaml";

import type { HealthCheck } from "../types";

/** What Deplo uses when a field is left blank. Docker's own defaults, rounded. */
export const HEALTH_CHECK_DEFAULTS = {
  intervalS: 30,
  timeoutS: 5,
  retries: 3,
  startPeriodS: 10,
} as const;

/**
 * A health check → the compose `healthcheck:` keys that run it.
 *
 * ONLY a command check renders one. An http check is asked by Deplo through the
 * agent instead (`lib/apps/http-health.ts`): a compose probe needs curl or wget
 * inside the image, and the images most people deploy have neither.
 */
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

/** Any compose keys as a YAML fragment indented `indent` spaces. */
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

/**
 * The same keys as a YAML fragment indented `indent` spaces - for the
 * string-built single-image path (`renderCompose`), which has no service object
 * to mutate. Empty string when there is no check, so the stack stays
 * byte-identical for an app that never turned one on.
 */
export function renderHealthCheckYaml(
  h: HealthCheck | null | undefined,
  indent: number,
): string {
  return renderYamlKeys(healthCheckToComposeKeys(h), indent);
}
