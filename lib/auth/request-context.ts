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
   * What the token may REACH. `null` means unrestricted — every team its creator
   * belongs to, and everything in it. Otherwise it is the tree the editor drew,
   * and an EMPTY one (every node it named has since been deleted) reaches
   * nothing, which is the whole reason the intent is stored separately.
   */
  scope: TokenScope | null;
  /** May administer the whole instance. Never true alongside a narrowed scope. */
  instanceAdmin: boolean;
}

/**
 * A token's resolved scope tree, flattened for lookup.
 *
 * Depth and breadth are different questions and are answered separately. WHICH
 * teams is breadth: a token holding two whole teams is not restricted inside
 * either of them. HOW MUCH of a team is depth: naming a project or an app inside
 * a team is what strips that team's team-wide capabilities, because there is no
 * per-project version of "manage members".
 */
export interface TokenScope {
  /** Every team the token can act in at all (whole ones plus derived ones). */
  teamIds: string[];
  /** Teams reachable WHOLLY — every project, every app, every team-wide setting. */
  wholeTeamIds: string[];
  /** Projects reachable wholly (every app in them, now and later). */
  projectIds: string[];
  /**
   * Folders reachable wholly, SUBTREE ALREADY EXPANDED — the ticked folders,
   * every folder nested under them, and every folder filed under a ticked
   * project. Expanded at authentication time rather than stored, so moving or
   * nesting a folder takes effect on the next request.
   */
  folderIds: string[];
  /** Individually-named apps. */
  appIds: string[];
  /**
   * The Projects a scoped node lives in — the container of an individually-named
   * app, or of a reachable folder — so a token given one app or one folder can
   * still see where it sits. Derived at authentication time.
   */
  appProjectIds: string[];
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
 * The scope narrowing this request BELOW the whole of its active team, or null
 * when nothing is: a cookie session, an unrestricted token, and a token holding
 * the active team wholly all answer null and are treated identically.
 *
 * That is the load-bearing distinction. Naming several teams is breadth and
 * restricts nothing inside them; naming a project or an app is depth, and depth
 * is what every check below (and the capability clamp) keys on.
 *
 * Synchronous and query-free by design: the scope rides on the identity, so it
 * can be consulted inside a `getDb().transaction()` (where opening a second
 * connection deadlocks pglite) and inside a subscription generator tick, where
 * nothing request-scoped is reachable.
 */
export function narrowedScope(): TokenScope | null {
  const id = currentIdentity();
  const scope = id?.token?.scope;
  if (!scope) return null;
  return scope.wholeTeamIds.includes(id!.teamId) ? null : scope;
}

/**
 * Refuse a PERSONAL-account action to an API token.
 *
 * The account surface — the signed-in device list, the profile, the password,
 * the two-factor settings — belongs to the person, and is the one part of the
 * data layer with no team and therefore no capability to gate on: it answers to
 * `assertUser()` alone. A bearer request resolves that same person, so without
 * this a token minted with nothing but the `view` floor, scoped to one project,
 * could read its creator's devices (with IP addresses), sign them out of every
 * one of them, and rename their account.
 *
 * That is precisely the impersonation this module's contract denies: a token is
 * a principal with its own capabilities, never a stand-in for the member who
 * minted it. There is no capability that could express "may administer the
 * human", so the boundary is the principal itself — token, refused.
 *
 * The cost is that "sign out everywhere" is no longer reachable from the API. It
 * is a dashboard action taken by a person who has lost a laptop, not something a
 * CI job does, and leaving it reachable meant every credential that ever leaked
 * could lock its owner out at will.
 */
export function requirePersonalSession(what: string): void {
  if (currentIdentity()?.token)
    throw new Error(
      `An API token can't access ${what}. Sign in to the dashboard to do that.`,
    );
}

/**
 * Whether a resource filed under `projectId` is reachable by this request.
 *
 * A resource with no Project (an app or folder at the team root) belongs to no
 * project and is therefore outside every narrowed scope — fail-closed, and it
 * keeps a scope from widening the moment someone drags a tile out of a project.
 * An individually-named app or folder makes its container visible, so a token
 * given one of them can still navigate to where it lives.
 */
export function inProjectScope(projectId: string | null | undefined): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  if (projectId == null) return false;
  return (
    scope.projectIds.includes(projectId) ||
    scope.appProjectIds.includes(projectId)
  );
}

/** Whether a Folder is reachable — its subtree is already expanded into the scope. */
export function inFolderScope(folderId: string | null | undefined): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  return folderId != null && scope.folderIds.includes(folderId);
}

/**
 * Whether an app row is reachable — by its own id, by its folder, or by its
 * project. An app lives in exactly ONE of those places (filing it into a folder
 * clears its project link), so the three are alternatives, not a hierarchy to
 * walk here: the folder subtree and the project's folders were flattened into
 * `folderIds` when the token authenticated.
 */
export function inAppScope(app: {
  id: string;
  projectId?: string | null;
  folderId?: string | null;
}): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  if (scope.appIds.includes(app.id)) return true;
  if (app.folderId != null && scope.folderIds.includes(app.folderId)) return true;
  return app.projectId != null && scope.projectIds.includes(app.projectId);
}
