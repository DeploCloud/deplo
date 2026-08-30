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
 * The shell one line of an http check runs.
 *
 * curl OR wget, because neither is guaranteed to be in an image and most images
 * have one of them. An image with neither cannot do an http check at all, which is
 * what the field's own help says.
 */
export function httpProbeCommand(path: string, port: number): string {
  const url = `http://127.0.0.1:${port}${path.startsWith("/") ? path : `/${path}`}`;
  return `curl -fsS -o /dev/null ${url} || wget -q -O /dev/null ${url} || exit 1`;
}

/** A health check → the compose `healthcheck:` keys that run it. */
export function healthCheckToComposeKeys(
  h: HealthCheck | null | undefined,
  fallbackPort: number,
): Record<string, unknown> {
  if (!h) return {};
  const test =
    h.type === "command"
      ? h.command?.trim()
      : httpProbeCommand(h.path?.trim() || "/", h.port ?? fallbackPort);
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
  fallbackPort: number,
  indent: number,
): string {
  return renderYamlKeys(healthCheckToComposeKeys(h, fallbackPort), indent);
}
