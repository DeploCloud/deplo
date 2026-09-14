import "server-only";

import { CleanupScope } from "../../agent/gen/agent";
import type { CleanupScopeResult } from "../../agent/gen/agent";

// CLEANUP_SCOPES - the scopes that exist, in display order.
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

// CleanupRunItem - a run's per-scope breakdown: counts, not object ids.
export interface CleanupRunItem {
  scope: CleanupScopeId;
  reclaimedBytes: number;
  itemsRemoved: number;
  skipped: boolean;
  error: string | null;
}

/**
 * Canonicalize a scope list on WRITE. Deduping is not cosmetic - `(policy_id,
 * scope)` is the junction's PK, so a repeated scope would fail the save.
 */
export function normalizeScopes(scopes: readonly string[]): CleanupScopeId[] {
  for (const s of scopes) {
    if (!(CLEANUP_SCOPES as readonly string[]).includes(s)) {
      throw new Error(`"${s}" is not a Docker cleanup scope`);
    }
  }
  return CLEANUP_SCOPES.filter((s) => scopes.includes(s));
}

/**
 * When each scope became a box the operator could tick, ISO-8601. A saved policy
 * stores the scopes SELECTED, so absence read as "turned off" made every new scope
 * dead on arrival.
 */
const SCOPE_SINCE: Record<CleanupScopeId, string> = {
  build_cache: "2026-01-01T00:00:00.000Z",
  dangling_images: "2026-01-01T00:00:00.000Z",
  unused_app_images: "2026-01-01T00:00:00.000Z",
  leftover_app_files: "2026-08-23T16:31:09.000Z",
  leftover_networks: "2026-08-30T00:00:00.000Z",
  // Supersedes `orphan_buildkit_cache` (a buildkit store is one anonymous volume).
  orphan_volumes: "2026-09-06T00:00:00.000Z",
  unused_pulled_images: "2026-09-06T00:00:00.000Z",
};

/**
 * The stored selection, plus every scope that did not exist when it was saved: one
 * the operator SAW and unticked stays off, one they were never offered is on.
 */
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

/** The scopes a deploy-time sweep runs, in allow-list order: the images the deploy
 *  just superseded and the cache ceiling the build just pushed against. */
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

/**
 * Map the agent's per-scope results back to our ids, DEDUPED and with any scope we
 * do not recognise dropped (a newer agent could answer with an enum value this
 * control plane predates).
 */
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

/** Per-scope lines always read in the allow-list's order, whatever order they landed in. */
export function orderItems(items: CleanupRunItem[]): CleanupRunItem[] {
  return CLEANUP_SCOPES.flatMap((s) => items.filter((i) => i.scope === s));
}
