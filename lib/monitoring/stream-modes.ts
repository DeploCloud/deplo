import "server-only";

// Its own module because the supervisor WRITES it and `lib/data/container-metrics` READS it.

const STATE_KEY = Symbol.for("deplo.monitoring.stream-unsupported");
const g = globalThis as unknown as { [STATE_KEY]?: Set<string> };
const unsupported: Set<string> = (g[STATE_KEY] ??= new Set());

// The agent predates the stream: polled for host metrics only, so no container ever reports.
export function markMetricsStreamUnsupported(serverId: string): void {
  unsupported.add(serverId);
}

// Cleared when a stream opens: the agent was updated.
export function clearMetricsStreamUnsupported(serverId: string): void {
  unsupported.delete(serverId);
}

export function metricsStreamUnsupported(serverId: string): boolean {
  return unsupported.has(serverId);
}
