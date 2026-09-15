import "server-only";

import { CleanupScope } from "../../agent/gen/agent";
import type { CleanupScopeResult } from "../../agent/gen/agent";

export const CLEANUP_SCOPES = [
  "build_cache",
  "dangling_images",
  "orphan_volumes",
  "unused_app_images",
  "unused_pulled_images",
  "leftover_app_files",
  "leftover_networks",
] as const;

export type CleanupScopeId = (typeof CLEANUP_SCOPES)[number];
export type CleanupTrigger = "manual" | "scheduled";
export type CleanupRunStatus = "running" | "success" | "failed";

export interface CleanupRunItem {
  scope: CleanupScopeId;
  reclaimedBytes: number;
  itemsRemoved: number;
  skipped: boolean;
  error: string | null;
}

export function normalizeScopes(scopes: readonly string[]): CleanupScopeId[] {
  for (const s of scopes) {
    if (!(CLEANUP_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`"${s}" is not a Docker cleanup scope`);
    }
  }
  return CLEANUP_SCOPES.filter((s) => scopes.includes(s));
}

const SCOPE_SINCE: Record<CleanupScopeId, string> = {
  build_cache: "2026-01-01T00:00:00.000Z",
  dangling_images: "2026-01-01T00:00:00.000Z",
  unused_app_images: "2026-01-01T00:00:00.000Z",
  leftover_app_files: "2026-08-23T16:31:09.000Z",
  leftover_networks: "2026-08-30T00:00:00.000Z",
  orphan_volumes: "2026-09-06T00:00:00.000Z",
  unused_pulled_images: "2026-09-06T00:00:00.000Z",
};

export function effectiveScopes(
  stored: readonly string[],
  savedAt: string,
): CleanupScopeId[] {
  return CLEANUP_SCOPES.filter(
    (s) => stored.includes(s) || SCOPE_SINCE[s] > savedAt,
  );
}

export const SCOPE_TO_WIRE: Record<CleanupScopeId, CleanupScope> = {
  build_cache: CleanupScope.CLEANUP_SCOPE_BUILD_CACHE,
  dangling_images: CleanupScope.CLEANUP_SCOPE_DANGLING_IMAGES,
  orphan_volumes: CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES,
  unused_app_images: CleanupScope.CLEANUP_SCOPE_UNUSED_APP_IMAGES,
  unused_pulled_images: CleanupScope.CLEANUP_SCOPE_UNUSED_PULLED_IMAGES,
  leftover_app_files: CleanupScope.CLEANUP_SCOPE_LEFTOVER_APP_FILES,
  leftover_networks: CleanupScope.CLEANUP_SCOPE_LEFTOVER_NETWORKS,
};

export function deploySweepScopes(
  scopes: readonly CleanupScopeId[],
): CleanupScope[] {
  return CLEANUP_SCOPES.filter(
    (s) =>
      (s === "unused_app_images" || s === "build_cache") && scopes.includes(s),
  ).map((s) => SCOPE_TO_WIRE[s]);
}

const WIRE_TO_SCOPE = new Map<CleanupScope, CleanupScopeId>(
  (Object.entries(SCOPE_TO_WIRE) as [CleanupScopeId, CleanupScope][]).map(
    ([id, wire]) => [wire, id],
  ),
);

export function toRunItems(results: CleanupScopeResult[]): CleanupRunItem[] {
  const byScope = new Map<CleanupScopeId, CleanupRunItem>();
  for (const r of results) {
    const scope = WIRE_TO_SCOPE.get(r.scope);
    if (!scope) {
      console.warn(
        `[cleanup] agent reported an unknown scope (${r.scope}); ignoring it`,
      );
      continue;
    }
    if (byScope.has(scope)) continue;
    byScope.set(scope, {
      scope,
      reclaimedBytes: Number(r.reclaimedBytes ?? 0),
      itemsRemoved: r.itemsRemoved ?? 0,
      skipped: r.skipped ?? false,
      error: r.error || null,
    });
  }
  return CLEANUP_SCOPES.filter((s) => byScope.has(s)).map((s) =>
    byScope.get(s)!,
  );
}

export function orderItems(items: CleanupRunItem[]): CleanupRunItem[] {
  return CLEANUP_SCOPES.flatMap((s) => items.filter((i) => i.scope === s));
}
