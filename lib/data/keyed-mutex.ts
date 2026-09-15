type Tail = Promise<unknown>;

const REGISTRY_KEY = Symbol.for("deplo.data.keyed-mutex");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Tail> };

const chains: Map<string, Tail> = (g[REGISTRY_KEY] ??= new Map());

export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
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

export function hasPendingLock(key: string): boolean {
  return chains.has(key);
}
