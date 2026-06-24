import { eq, sql } from "drizzle-orm";

import { storeMigration } from "../schema/control-plane";
import type { BackfillDb, BackfillTx } from "./types";

/**
 * Per-cut-set backfill markers (relational-store PLAN §7 "The engine").
 *
 * One row per cut-set in `store_migration`. A cut-set's backfill is a no-op once
 * its marker exists (idempotent across boots / rolling restarts), and a fresh
 * install writes all four markers with zero copied rows. The marker is written
 * INSIDE the cut-set's FK-ordered copy transaction (see {@link writeMarker}), so
 * it can never commit ahead of the rows it vouches for — a crash mid-copy rolls
 * back both the rows and the marker, and the next boot re-runs the whole copy.
 */

/** The four cut-sets, in migration order (PLAN §3 "The four cut-sets"). */
export const CUT_SETS = {
  leaf: "backfill_leaf",
  identity: "backfill_identity",
  projectGraph: "backfill_project_graph",
  backups: "backfill_backups",
} as const;

export type CutSet = (typeof CUT_SETS)[keyof typeof CUT_SETS];

/** True once the named cut-set's backfill has completed (its marker row exists). */
export async function markerExists(
  db: BackfillDb,
  name: CutSet,
): Promise<boolean> {
  const rows = await db
    .select({ one: sql<number>`1` })
    .from(storeMigration)
    .where(eq(storeMigration.name, name))
    .limit(1);
  return rows.length > 0;
}

/**
 * Record the named cut-set's marker. MUST run inside the copy transaction (`tx`)
 * so the marker commits atomically with the copied rows. `ON CONFLICT DO NOTHING`
 * keeps it idempotent: a re-run that somehow reaches here (it should be gated out
 * by {@link markerExists}) leaves the original `completed_at` untouched.
 */
export async function writeMarker(tx: BackfillTx, name: CutSet): Promise<void> {
  await tx.insert(storeMigration).values({ name }).onConflictDoNothing();
}
