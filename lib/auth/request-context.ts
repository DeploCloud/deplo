import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Identity override for non-cookie callers (the public GraphQL API).
 *
 * The whole data layer resolves the caller through `getCurrentUser()` and
 * `getActiveTeamId()`, which normally read the `deplo_session` / `deplo_team`
 * cookies. An external client authenticates with `Authorization: Bearer
 * deplo_…` instead — it has no cookies. Rather than thread an identity argument
 * through ~100 data functions, the GraphQL route handler resolves the bearer
 * token to a principal and runs the operation inside `runWithIdentity(...)`.
 *
 * `getCurrentUser()` / `getActiveTeamId()` consult this store FIRST and fall
 * back to cookies when it is empty. So:
 *   - browser (same-origin, sends cookies) → store empty → cookie path, unchanged.
 *   - bearer token → store populated → identity comes from the token.
 *
 * This is the single seam that makes every team-scoped read/write and every
 * `requireCapability` check work identically for both client classes.
 */
export interface RequestIdentity {
  userId: string;
  teamId: string;
}

// In `next dev` the RSC layer and the route-handler layer compile into separate
// module registries, so a module-level `new AsyncLocalStorage()` would exist as
// TWO independent instances in one process — `runWithIdentity` (called from the
// route handler / yoga) would write to one while `currentIdentity()` (called
// from the data layer, possibly the RSC graph) reads the other, and the override
// would be invisible. Pinning the single store on `globalThis` (one V8 isolate
// per process) collapses every module instance onto ONE store. Mirrors the
// pattern in lib/store.ts.
const STORE_KEY = Symbol.for("deplo.request-identity.als");
const g = globalThis as unknown as {
  [STORE_KEY]?: AsyncLocalStorage<RequestIdentity>;
};
const store: AsyncLocalStorage<RequestIdentity> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<RequestIdentity>());

/** Run `fn` with the given identity visible to the data layer. */
export function runWithIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return store.run(identity, fn);
}

/** The overriding identity for the current async context, or null. */
export function currentIdentity(): RequestIdentity | null {
  return store.getStore() ?? null;
}
