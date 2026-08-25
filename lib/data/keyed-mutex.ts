/**
 * A process-wide per-key async mutex: operations sharing a key run one at a time,
 * in submission order; operations on different keys run concurrently.
 */

type Tail = Promise<unknown>;

const REGISTRY_KEY = Symbol.for("deplo.data.keyed-mutex");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Tail> };

/** The shared per-key tail-promise registry (one entry per in-flight key). */
const chains: Map<string, Tail> = (g[REGISTRY_KEY] ??= new Map());

/**
 * Run `fn` while holding the lock for `key`.
 */
export function withKeyedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Chain onto the key's current tail; swallow the predecessor's result/rejection
  // so one operation's failure can't reject a later, unrelated one waiting behind
  // it. `prev` is only a sequencing barrier, never a value/error source.
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);

  // The tail tracks completion (success OR failure) purely for ordering.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);

  // Drop the key once OUR tail is the registry's current one and it has settled —
  // i.e. nothing newer chained behind us. Guards against deleting a fresher chain.
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });

  return run;
}

/** Test-only: is any operation currently queued/running for this key? */
export function hasPendingLock(key: string): boolean {
  return chains.has(key);
}
