import "server-only";

const STATE_KEY = Symbol.for("deplo.monitoring.stream-unsupported");
const g = globalThis as unknown as { [STATE_KEY]?: Set<string> };
const unsupported: Set<string> = (g[STATE_KEY] ??= new Set());

export function markMetricsStreamUnsupported(serverId: string): void {
  unsupported.add(serverId);
}

export function clearMetricsStreamUnsupported(serverId: string): void {
  unsupported.delete(serverId);
}

export function metricsStreamUnsupported(serverId: string): boolean {
  return unsupported.has(serverId);
}
