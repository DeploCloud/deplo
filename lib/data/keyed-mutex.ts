/**
 * A process-wide per-key async mutex: operations sharing a key run one at a time,
 * in submission order; operations on different keys run concurrently.
 *
 * Why this exists: database lifecycle work (provision / start / stop / destroy)
 * for one DB must not interleave. The classic bug is delete-during-provision —
 * `createDatabase` fires the provision (`reroute` = `compose up -d`) as a floated
 * background task, so a `deleteDatabase` (`destroyStack` = `down -v`) can land in
 * the middle: the teardown runs, then the still-in-flight provision's `up -d`
 * recreates the container + volume, and the row is already gone → an orphan the
 * control plane no longer tracks. Serializing every lifecycle verb for a given
 * `db.id` on one key closes that window: a delete now WAITS for an in-flight
 * provision to finish, then tears the (now fully-created) stack down.
 *
 * Singleton on `globalThis` via `Symbol.for(...)` — the same pattern as the store
 * (lib/store.ts): Next builds the RSC and route-handler module graphs separately,
 * so a per-module Map would give each graph its own lock and a provision in one
 * graph wouldn't block a delete in the other. The keyed-on-globalThis registry is
 * shared across both. `next start` is single-process, so an in-process lock is a
 * real mutex here (a multi-process deploy would need a distributed lock instead).
 */

type Tail = Promise<unknown>;

const REGISTRY_KEY = Symbol.for("deplo.data.keyed-mutex");
const g = globalThis as unknown as { [REGISTRY_KEY]?: Map<string, Tail> };

/** The shared per-key tail-promise registry (one entry per in-flight key). */
const chains: Map<string, Tail> = (g[REGISTRY_KEY] ??= new Map());

/**
 * Run `fn` while holding the lock for `key`. Resolves/rejects with `fn`'s result;
 * a thrown `fn` releases the lock (the next waiter still runs) and does NOT poison
 * the chain. When a key's chain fully drains it is dropped from the registry so the
 * map stays bounded to currently-contended keys.
 */
export function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
