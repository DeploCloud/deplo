type Tail = Promise<unknown>;

const REGISTRY_KEY = Symbol.for("deplo.data.keyed-mutex");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Tail> };

const chains: Map<string, Tail> = (g[REGISTRY_KEY] ??= new Map());

// withKeyedLock runs fn while holding the lock for key.
export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Both handlers: a predecessor's failure must not reject the next operation.
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);

  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);

  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });

  return run;
}

// hasPendingLock is test-only: is any operation queued or running for this key?
export function hasPendingLock(key: string): boolean {
  return chains.has(key);
}
