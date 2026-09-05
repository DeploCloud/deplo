import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";
import { cache as reactCache } from "react";

import { currentIdentity } from "./auth/request-context";

type Store = Map<unknown, Map<string, unknown>>;

// Same globalThis rationale as lib/auth/request-context.ts.
const STORE_KEY = Symbol.for("deplo.request-cache.als");
const g = globalThis as unknown as { [STORE_KEY]?: AsyncLocalStorage<Store> };
const als: AsyncLocalStorage<Store> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<Store>());

/** Run `fn` with a fresh memo: a request React does not render, e.g. a route handler. */
export function withRequestCache<T>(fn: () => T): T {
  return als.run(new Map(), fn);
}

/** Run `fn` with no memo, whatever scope is open: a mutation reads what it just wrote. */
export function withoutRequestCache<T>(fn: () => T): T {
  return als.exit(fn);
}

/**
 * `React.cache` that also memoizes inside {@link withRequestCache}, where React's
 * own is a pass-through. Keyed on the arguments AND on the identity the call runs
 * under, so a cross-team loop under `runWithIdentity` never reads a stale answer.
 */
export function cache<A extends unknown[], R>(
  fn: (...args: A) => R,
): (...args: A) => R {
  const rendered = reactCache(fn);
  return (...args: A): R => {
    const store = als.getStore();
    if (!store) return rendered(...args);
    let byKey = store.get(fn);
    if (!byKey) store.set(fn, (byKey = new Map()));
    const id = currentIdentity();
    const key = `${id?.userId ?? ""}|${id?.teamId ?? ""}|${id?.token?.id ?? ""}|${JSON.stringify(args)}`;
    if (byKey.has(key)) return byKey.get(key) as R;
    const value = fn(...args);
    byKey.set(key, value);
    return value;
  };
}
