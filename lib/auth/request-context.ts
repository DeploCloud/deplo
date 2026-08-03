import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { Capability } from "../types";

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
  /**
   * Present ONLY for a bearer-token request: the token's own grant. A token is
   * never root — `membershipFor` in `lib/membership.ts` intersects the member's
   * live capabilities with these, so the token can do at most what it was given
   * AND at most what its creator can still do. Absent means a cookie session,
   * which is unclamped.
   */
  token?: TokenGrant;
}

/** What an API token was granted when it was minted. See {@link RequestIdentity}. */
export interface TokenGrant {
  id: string;
  capabilities: Capability[];
  /**
   * The Projects this token may reach. `null` means unscoped (the whole team);
   * `[]` means scoped to nothing left — a scope whose projects were all deleted,
   * which must fail closed rather than read as "no scope".
   */
  projectIds: string[] | null;
  /** May administer the whole instance. Never true alongside a project scope. */
  instanceAdmin: boolean;
}

// In `next dev` the RSC layer and the route-handler layer compile into separate
// module registries, so a module-level `new AsyncLocalStorage()` would exist as
// TWO independent instances in one process — `runWithIdentity` (called from the
// route handler / yoga) would write to one while `currentIdentity()` (called
// from the data layer, possibly the RSC graph) reads the other, and the override
// would be invisible. Pinning the single store on `globalThis` (one V8 isolate
// per process) collapses every module instance onto ONE store. Mirrors the
// pattern in lib/db/client.ts.
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

/**
 * The Projects the current request is limited to, or null when it isn't limited.
 *
 * Synchronous and query-free by design: the scope rides on the identity, so it
 * can be consulted inside a `getDb().transaction()` (where opening a second
 * connection deadlocks pglite) and inside a subscription generator tick, where
 * nothing request-scoped is reachable.
 */
export function tokenProjectScope(): string[] | null {
  return currentIdentity()?.token?.projectIds ?? null;
}

/**
 * Whether a resource filed under `projectId` is reachable by this request.
 *
 * A resource with no Project (a top-level app, a folder at the team root)
 * belongs to no scope and is therefore outside every scope — fail-closed, and it
 * keeps a scope from widening the moment someone drags a tile out of a project.
 * Always true for a cookie request and for an unscoped token.
 */
export function inProjectScope(projectId: string | null | undefined): boolean {
  const ids = tokenProjectScope();
  return !ids || (projectId != null && ids.includes(projectId));
}
