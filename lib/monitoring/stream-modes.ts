import "server-only";

/**
 * Which servers cannot serve the telemetry stream, so the Monitoring tab can say
 * "update the agent" instead of "no metrics yet - check that server".
 *
 * Its own module because the supervisor WRITES it and `lib/data/container-metrics`
 * READS it, and the supervisor already imports that file to aggregate a frame.
 */

const STATE_KEY = Symbol.for("deplo.monitoring.stream-unsupported");
const g = globalThis as unknown as { [STATE_KEY]?: Set<string> };
const unsupported: Set<string> = (g[STATE_KEY] ??= new Set());

/** The agent on this server predates the stream: it is being polled for host
 *  metrics only, so none of its containers will ever report. */
export function markMetricsStreamUnsupported(serverId: string): void {
  unsupported.add(serverId);
}

/** Cleared when a stream opens: the agent was updated. */
export function clearMetricsStreamUnsupported(serverId: string): void {
  unsupported.delete(serverId);
}

export function metricsStreamUnsupported(serverId: string): boolean {
  return unsupported.has(serverId);
}
