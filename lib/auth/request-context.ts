import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { Capability } from "../types";

/**
 * Identity override for non-cookie callers (the public GraphQL API).
 */
export interface RequestIdentity {
  userId: string;
  teamId: string;
  /**
   * The browser session this request rides on, when the caller already knows it.
   */
  sessionId?: string;
  /**
   * Present ONLY for a bearer-token request: the token's own grant.
   */
  token?: TokenGrant;
}

/** What an API token was granted when it was minted. See {@link RequestIdentity}. */
export interface TokenGrant {
  id: string;
  capabilities: Capability[];
  /**
   * What the token may REACH.
   */
  scope: TokenScope | null;
  /** May administer the whole instance. Never true alongside a narrowed scope. */
  instanceAdmin: boolean;
}

/**
 * A token's resolved scope tree, flattened for lookup.
 */
export interface TokenScope {
  /** Every team the token can act in at all (whole ones plus derived ones). */
  teamIds: string[];
  /** Teams reachable WHOLLY - every project, every app, every team-wide setting. */
  wholeTeamIds: string[];
  /** Projects reachable wholly (every app in them, now and later). */
  projectIds: string[];
  /**
   * Folders reachable wholly, SUBTREE ALREADY EXPANDED - the ticked folders, every
   * folder nested under them, and every folder filed under a ticked project.
   */
  folderIds: string[];
  /** Individually-named apps. */
  appIds: string[];
  /**
   * The Projects a scoped node lives in - the container of an individually-named
   * app, or of a reachable folder, so a token given one app or one folder can
   * still see where it sits. Derived at authentication time.
   */
  appProjectIds: string[];
}

// In `next dev` the RSC layer and the route-handler layer compile into separate
// module registries, so a module-level `new AsyncLocalStorage()` would exist as TWO
// independent instances in one process - `runWithIdentity` (called from the route
// handler / yoga) would write to one while `currentIdentity()` (called from the
// data layer, possibly the RSC graph) reads the other, and the override would be
// invisible.
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
 */
export function narrowedScope(): TokenScope | null {
  const id = currentIdentity();
  const scope = id?.token?.scope;
  if (!scope) return null;
  return scope.wholeTeamIds.includes(id!.teamId) ? null : scope;
}

/**
 * Refuse a PERSONAL-account action to an API token. That is precisely the
 * impersonation this module's contract denies: a token is a principal with its own
 * capabilities, never a stand-in for the member who minted it.
 */
export function requirePersonalSession(what: string): void {
  if (currentIdentity()?.token)
    throw new Error(
      `An API token can't access ${what}. Sign in to the dashboard to do that.`,
    );
}

/**
 * Whether a resource filed under `projectId` is reachable by this request.
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

/** Whether a Folder is reachable - its subtree is already expanded into the scope. */
export function inFolderScope(folderId: string | null | undefined): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  return folderId != null && scope.folderIds.includes(folderId);
}

/**
 * Whether an app row is reachable - by its own id, by its folder, or by its
 * project.
 */
export function inAppScope(app: {
  id: string;
  projectId?: string | null;
  folderId?: string | null;
}): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  if (scope.appIds.includes(app.id)) return true;
  if (app.folderId != null && scope.folderIds.includes(app.folderId))
    return true;
  return app.projectId != null && scope.projectIds.includes(app.projectId);
}
