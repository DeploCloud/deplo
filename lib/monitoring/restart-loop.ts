export const RESTART_LOOP_THRESHOLD = 10;

export const RESTART_LOOP_WINDOW_MS = 30 * 60_000;

export interface RestartSample {
  name: string;
  containerId: string;
  state: string;
  restartCount: number;
}

interface Baseline {
  containerId: string;
  count: number;
  at: number;
}

/**
 * ponytail: tumbling window, so a loop straddling two windows takes up to 2x to trip.
 * A sliding window needs a ring buffer per container, for a guard that fires in minutes.
 */
const KEY = Symbol.for("deplo.monitoring.restart-loop");
const baselines = ((globalThis as Record<symbol, unknown>)[KEY] ??= new Map<
  string,
  Baseline
>()) as Map<string, Baseline>;

/**
 * Container names whose restarts climbed past the threshold inside the window.
 * `samples` is the WHOLE host's set, which is also what prunes containers that are gone.
 */
export function loopingContainers(
  serverId: string,
  samples: readonly RestartSample[],
  now: number = Date.now(),
): string[] {
  const seen = new Set<string>();
  const looping: string[] = [];

  for (const s of samples) {
    const key = `${serverId}:${s.name}`;
    seen.add(key);
    const prev = baselines.get(key);
    // A recreated container is a new life: its id changes and docker's own count restarts at 0.
    const stale =
      !prev ||
      prev.containerId !== s.containerId ||
      s.restartCount < prev.count ||
      now - prev.at > RESTART_LOOP_WINDOW_MS;
    if (stale) {
      baselines.set(key, {
        containerId: s.containerId,
        count: s.restartCount,
        at: now,
      });
      continue;
    }
    if (s.restartCount - prev.count >= RESTART_LOOP_THRESHOLD)
      looping.push(s.name);
  }

  for (const key of baselines.keys())
    if (key.startsWith(`${serverId}:`) && !seen.has(key)) baselines.delete(key);

  return looping;
}

/** A stopped container must not count its old restarts against it when it comes back. */
export function forgetContainers(serverId: string, names: string[]): void {
  for (const name of names) baselines.delete(`${serverId}:${name}`);
}
