import type { DeploData } from "../../types";
import { buildSeed } from "../../seed";
import { migrate } from "../../migrate";
import { markerExists, writeMarker, type CutSet } from "./markers";
import type { BackfillDb, BackfillTx } from "./types";

/**
 * The cut-set backfill engine (relational-store PLAN §7 "The engine", Step 1).
 *
 * A cut-set's backfill is one **FK-ordered copy transaction**: it copies that
 * cut-set's collections from the fresh JSONB into the relational tables, runs an
 * **element-granular reconciliation assert**, and writes the cut-set's marker —
 * all in ONE transaction. Properties the engine guarantees:
 *
 *  - **Idempotent across boots.** Gated by the marker: if the marker row already
 *    exists the copy is skipped entirely (a no-op re-run). The marker write is the
 *    LAST act inside the tx, so it can never commit ahead of the rows.
 *  - **Mismatch ⇒ clean rollback ⇒ re-run.** A reconciliation throw aborts the
 *    whole tx (nothing half-applied, marker not written), so the next boot re-runs
 *    the copy from the still-live JSONB.
 *  - **Fresh install ⇒ marks done with zero rows.** An empty/absent collection
 *    copies nothing but still writes the marker, so a brand-new instance never
 *    re-attempts the copy.
 *
 * A {@link CutSetCopy} owns its collections' normalize/prune/explode + the
 * reconcile assert; the engine owns the transaction + marker discipline so every
 * cut-set inherits the same guarantees. The {@link BackfillDb} is injected so the
 * identical engine runs against production node-postgres and the pglite test
 * client (PLAN §8 "Engine parameterization").
 */

/**
 * A single cut-set's copy + reconcile, run inside the engine's transaction. It
 * receives the fresh JSONB document and the transaction handle, must insert all
 * of its cut-set's rows (FK-ordered) AND assert element-granular fidelity, and
 * throw on any mismatch (so the tx rolls back).
 */
export type CutSetCopy = (tx: BackfillTx, data: DeploData) => Promise<void>;

/**
 * Apply the SAME read-time normalization the data layer applies, so a legacy
 * JSONB row satisfies the new strict columns/FKs (relational-store PLAN §7
 * "normalize BEFORE exploding into strict child tables"). Store rows are never
 * rewritten today — `lib/store.ts` runs exactly this (`buildSeed`-backfill of
 * missing collections, then `migrate`) only against the in-memory cache and never
 * persists it, so the durable document the backfill copies from still carries the
 * raw legacy shape: rows missing a `teamId`/`userId`, an un-stamped `targetKind`,
 * legacy `notificationSettings`, etc. Running it here is what stamps those before
 * any cut-set explodes a collection into NOT-NULL/FK columns. `migrate` is
 * idempotent and mutates+returns the same object; it only touches the in-memory
 * doc, so each cut-set still copies only its own collections.
 */
export function normalizeForBackfill(data: DeploData): DeploData {
  const seed = buildSeed();
  const d = data as unknown as Record<string, unknown>;
  for (const key of Object.keys(seed) as (keyof DeploData)[]) {
    if (d[key] === undefined || d[key] === null) d[key] = seed[key] as unknown;
  }
  return migrate(data);
}

/**
 * Run a cut-set's backfill once. No-op if the marker already exists. Otherwise
 * normalizes the document (read-time fidelity), opens one transaction, runs `copy`
 * (which inserts + reconciles), then writes the marker — committing rows and
 * marker atomically. Any throw rolls the whole tx back and leaves the marker
 * absent so a later boot retries.
 */
export async function runBackfill(
  db: BackfillDb,
  cutSet: CutSet,
  data: DeploData,
  copy: CutSetCopy,
): Promise<void> {
  if (await markerExists(db, cutSet)) return;
  const normalized = normalizeForBackfill(data);
  await db.transaction(async (tx) => {
    // The outer markerExists check + the marker's ON CONFLICT DO NOTHING make a
    // SEQUENTIAL re-run a no-op (a later call sees the committed marker and
    // returns at the guard above). CONCURRENT at-most-once is NOT this layer's
    // job — it belongs to the lease gate (`gate.ts`), which serializes callers
    // process-wide; if two callers bypassed the gate and raced, the data inserts
    // (no ON CONFLICT) would make the losing tx throw on the PK rather than
    // double-copy, so at-most-once for the rows still holds.
    await copy(tx, normalized);
    await writeMarker(tx, cutSet);
  });
}
