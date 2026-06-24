import { pgTable, text, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * Legacy control-plane tables that survive the relational-store migration as
 * rollback artifacts (relational-store PLAN §1 "schema/legacy.ts", §7 "Fate of
 * the old deplo_state row"):
 *
 *  - `deplo_state` — the single-row JSONB document that holds the entire control
 *    plane today. NOT dropped during the migration; it stays the rollback
 *    artifact for the leaf cut-set and earlier. A much-later Step 7 drops it
 *    after production soak.
 *  - `scheduler_lease` — the cross-process backup-scheduler mutex, reused by the
 *    per-cut-set backfill gate. Stays.
 *
 * Timestamp-type reconciliation (PLAN §8 "Reconcile the two table-creation
 * regimes" + the Step -1 GATE result): the runtime `CREATE TABLE IF NOT EXISTS`
 * in `document-store.ts` created `deplo_state.updated_at` as `timestamptz`, but
 * the old Drizzle declaration said plain `timestamp` — a latent drift. The GATE
 * proved plain `timestamp` round-trips an ISO write to a SHIFTED hour, while
 * `timestamptz` round-trips byte-for-byte, so every `*_at` column uses
 * `withTimezone: true`. Aligning the declarations here is what lets `db:generate`
 * emit the baseline `ALTER … SET DATA TYPE timestamptz` and then report no drift,
 * after which migrations are the single regime that owns table creation (the
 * on-demand DDL is removed from `document-store.ts`/`lease.ts`).
 */

/** Single-document control-plane state (the legacy JSONB store). */
export const deploState = pgTable("deplo_state", {
  id: text("id").primaryKey(),
  data: jsonb("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Cross-process mutex for the backup scheduler. One row per named lease holds the
 * current owner and a heartbeat; a tick claims a lease via an atomic CAS
 * (insert-or-steal-if-stale) before running, so a due backup fires at most once
 * and a crashed owner's stale lease is re-armed. See `lib/backups/lease.ts`.
 */
export const schedulerLease = pgTable("scheduler_lease", {
  /** Lease name, e.g. "backup-scheduler". One row per distinct lease. */
  name: text("name").primaryKey(),
  /** Identifier of the process/instance currently holding the lease. */
  owner: text("owner").notNull(),
  /** Last heartbeat; a lease older than the staleness window is reclaimable. */
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
