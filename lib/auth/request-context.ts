import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import type { Capability } from "../types/identity";

export interface RequestIdentity {
  userId: string;
  teamId: string;
  sessionId?: string;
  token?: TokenGrant;
}

export interface TokenGrant {
  id: string;
  capabilities: Capability[];
  scope: TokenScope | null;
  instanceAdmin: boolean;
}

export interface TokenScope {
  teamIds: string[];
  wholeTeamIds: string[];
  projectIds: string[];
  folderIds: string[];
  appIds: string[];
  appProjectIds: string[];
}

const STORE_KEY = Symbol.for("deplo.request-identity.als");
const g = globalThis as unknown as {
  [STORE_KEY]?: AsyncLocalStorage<RequestIdentity>;
};
const store: AsyncLocalStorage<RequestIdentity> = (g[STORE_KEY] ??=
  new AsyncLocalStorage<RequestIdentity>());

export function runWithIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return store.run(identity, fn);
}

export function currentIdentity(): RequestIdentity | null {
  return store.getStore() ?? null;
}

export function narrowedScope(): TokenScope | null {
  const id = currentIdentity();
  const scope = id?.token?.scope;
  if (!scope) return null;
  return scope.wholeTeamIds.includes(id!.teamId) ? null : scope;
}

export function requirePersonalSession(what: string): void {
  if (currentIdentity()?.token)
    throw new Error(
      `An API token can't access ${what}. Sign in to the dashboard to do that.`,
    );
}

export function inProjectScope(projectId: string | null | undefined): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  if (projectId == null) return false;
  return (
    scope.projectIds.includes(projectId) ||
    scope.appProjectIds.includes(projectId)
  );
}

export function inFolderScope(folderId: string | null | undefined): boolean {
  const scope = narrowedScope();
  if (!scope) return true;
  return folderId != null && scope.folderIds.includes(folderId);
}

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
