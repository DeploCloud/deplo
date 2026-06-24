import { count, eq } from "drizzle-orm";

import type { DeploData, NotificationSettings } from "../../../types";
import { defaultNotificationSettings } from "../../../types";
import { settingsToRow } from "../../../data/notification-row";
import { appSlug } from "../../../apps/runtime";
import {
  apiTokens,
  installedApps,
  notificationSettings,
  registries,
  teams,
  users,
} from "../../schema/control-plane";
import type { CutSetCopy } from "../engine";
import type { BackfillTx } from "../types";
import { seedIdentityRoots } from "../roots";

/**
 * Cut-set (a) — leaf / isolated collections (relational-store PLAN §3 "Cut-set
 * (a)", Step 2). The four collections nothing else reads or writes:
 * `apiTokens`, `notificationSettings`, `registries`, `installedApps`. They are the
 * ONLY zero-cost-revert set, so they go first to prove the engine + the pglite
 * test backend end-to-end on the lowest risk.
 *
 * Backfill specifics for this cut-set (PLAN §7):
 *  - No orphan / dangling-id pruning. The only outbound FKs are `team_id` (all
 *    four) and `api_tokens.user_id` — none reference projects/databases — so the
 *    prune machinery belongs to cut-sets (c)/(d), not here. The FK roots
 *    (teams/users) are seeded idempotently so those NOT-NULL FKs resolve.
 *  - `installedApps.slug`: derived for legacy empty-slug rows via
 *    `appSlug(catalogId, teamSlug)` (PLAN §2 `installed_apps`).
 *  - `notificationSettings` is a `Record<teamId, …>` map → one row per present
 *    key. A team with NO entry stays ABSENT (its read falls back to
 *    `defaultNotificationSettings()`); we never materialize a default row, or the
 *    count assert would over-count (PLAN §2 `notification_settings`).
 *
 * Reconciliation is element-granular but structurally simple (no SUM-of-arrays,
 * no FK sweep beyond team_id/user_id): exact row counts (no prune ⇒ raw count IS
 * the expected count), the notification_settings channel+event round-trip with a
 * compile-time exhaustiveness guard, derived-slug non-emptiness, and user_id
 * resolution.
 */

// The flat-columns ↔ nested-object mapping (with its compile-time
// exhaustiveness guard over every NotificationEvent) lives in
// `lib/data/notification-row.ts` — the ONE shared mapping this cut-set's copy
// and the live data layer both use, so the two can't drift (PLAN §2/§7).

/* ------------------------------------------------------------------ */
/* Copy                                                                */
/* ------------------------------------------------------------------ */

async function copyLeaf(tx: BackfillTx, data: DeploData): Promise<void> {
  // FK roots first (PLAN §2 "roots first"): the leaf FKs reference teams/users.
  await seedIdentityRoots(tx, data);

  const teamSlugById = new Map(data.teams.map((t) => [t.id, t.slug] as const));

  if (data.apiTokens.length > 0) {
    await tx.insert(apiTokens).values(
      data.apiTokens.map((t) => ({
        id: t.id,
        teamId: t.teamId,
        userId: t.userId,
        name: t.name,
        tokenHash: t.tokenHash,
        prefix: t.prefix,
        lastUsedAt: t.lastUsedAt,
        createdAt: t.createdAt,
      })),
    );
  }

  if (data.registries.length > 0) {
    await tx.insert(registries).values(
      data.registries.map((r) => ({
        id: r.id,
        teamId: r.teamId,
        name: r.name,
        type: r.type,
        registryUrl: r.registryUrl,
        username: r.username,
        passwordEnc: r.passwordEnc,
        createdAt: r.createdAt,
      })),
    );
  }

  if (data.installedApps.length > 0) {
    await tx.insert(installedApps).values(
      data.installedApps.map((a) => ({
        id: a.id,
        teamId: a.teamId,
        catalogId: a.catalogId,
        // Derive the frozen slug for legacy empty-slug rows (PLAN §2).
        slug: a.slug || appSlug(a.catalogId, teamSlugById.get(a.teamId) ?? ""),
        version: a.version,
        createdAt: a.createdAt,
      })),
    );
  }

  // notificationSettings: one row per PRESENT key only (absent ⇒ default at read).
  const settingsEntries = Object.entries(data.notificationSettings ?? {});
  if (settingsEntries.length > 0) {
    await tx
      .insert(notificationSettings)
      .values(settingsEntries.map(([teamId, s]) => settingsToRow(teamId, s)));
  }

  await reconcileLeaf(tx, data);
}

/* ------------------------------------------------------------------ */
/* Reconcile (element-granular)                                         */
/* ------------------------------------------------------------------ */

async function rowCount(
  tx: BackfillTx,
  table: typeof apiTokens | typeof registries | typeof installedApps | typeof notificationSettings,
): Promise<number> {
  const r = await tx.select({ n: count() }).from(table);
  return r[0]?.n ?? 0;
}

function fail(msg: string): never {
  // A reconcile mismatch throws so the engine's tx rolls back, the marker is not
  // written, and the next boot re-runs the copy from the still-live JSONB.
  throw new Error(`[backfill:leaf] reconcile mismatch: ${msg}`);
}

/**
 * Element-granular reconciliation of the leaf cut-set against the source `data`.
 * Throws on the first mismatch (so the engine's tx rolls back, the marker is not
 * written, and the next boot re-runs from the still-live JSONB). Exported so a
 * test can drive a mismatch the DB constraints alone wouldn't catch (a count or a
 * notification-settings value drift).
 */
export async function reconcileLeaf(
  tx: BackfillTx,
  data: DeploData,
): Promise<void> {
  // (1) Exact row counts — no prune for the leaf cut-set, so the raw collection
  // size IS the expected count.
  const tokenCount = await rowCount(tx, apiTokens);
  if (tokenCount !== data.apiTokens.length)
    fail(`api_tokens ${tokenCount} != ${data.apiTokens.length}`);

  const registryCount = await rowCount(tx, registries);
  if (registryCount !== data.registries.length)
    fail(`registries ${registryCount} != ${data.registries.length}`);

  const appCount = await rowCount(tx, installedApps);
  if (appCount !== data.installedApps.length)
    fail(`installed_apps ${appCount} != ${data.installedApps.length}`);

  const settingsKeys = Object.keys(data.notificationSettings ?? {});
  const settingsCount = await rowCount(tx, notificationSettings);
  if (settingsCount !== settingsKeys.length)
    fail(`notification_settings ${settingsCount} != ${settingsKeys.length}`);

  // (2) installed_apps: derived slug must be non-empty for every row.
  const emptySlug = await tx
    .select({ id: installedApps.id })
    .from(installedApps)
    .where(eq(installedApps.slug, ""))
    .limit(1);
  if (emptySlug.length > 0)
    fail(`installed_apps has an empty slug (${emptySlug[0]!.id})`);

  // (3) api_tokens.user_id must resolve to a real user (the one non-team leaf FK).
  for (const t of data.apiTokens) {
    const u = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, t.userId))
      .limit(1);
    if (u.length === 0)
      fail(`api_token ${t.id} references missing user ${t.userId}`);
  }

  // (4) team_id existence for every leaf row (the shared NOT-NULL FK).
  for (const row of [
    ...data.apiTokens,
    ...data.registries,
    ...data.installedApps,
  ]) {
    const team = await tx
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, row.teamId))
      .limit(1);
    if (team.length === 0)
      fail(`leaf row ${row.id} references missing team ${row.teamId}`);
  }

  // (5) notification_settings round-trip: every channel/address column and every
  // event boolean must equal the source, per team.
  for (const [teamId, raw] of Object.entries(data.notificationSettings ?? {})) {
    const persisted = await tx
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.teamId, teamId))
      .limit(1);
    const got = persisted[0];
    if (!got) fail(`notification_settings missing row for team ${teamId}`);
    const want = settingsToRow(teamId, raw as NotificationSettings);
    for (const key of Object.keys(want) as (keyof typeof want)[]) {
      if (got[key] !== want[key])
        fail(`notification_settings.${key} for ${teamId}: ${got[key]} != ${want[key]}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The leaf cut-set's copy, for {@link runBackfill}. Re-exported as a named const. */
export const leafCutSetCopy: CutSetCopy = copyLeaf;

// Re-export for reuse by the identity cut-set / tests that want the default.
export { defaultNotificationSettings };
