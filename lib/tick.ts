/**
 * One shared clock for every relative timestamp on the page: a single interval,
 * whatever the number of subscribers, and none at all once the last one leaves.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let now = Date.now();

export function subscribeToTick(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= setInterval(() => {
    now = Date.now();
    for (const l of listeners) l();
  }, 1000);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The instant of the last tick - stable between them, so it is a snapshot. */
export function tickNow(): number {
  return now;
}
