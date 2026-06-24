import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The cross-process backup-scheduler mutex.
 *
 * Formerly co-located with the legacy `deplo_state` JSONB document in
 * `schema/legacy.ts`; that file was dropped when the relational-store migration
 * finished (PLAN Step 7), but `scheduler_lease` is LIVE — it is the backup
 * scheduler's at-most-once guard — so it moved here on its own.
 *
 * One row per named lease holds the current owner and a heartbeat; a tick claims
 * a lease via an atomic CAS (insert-or-steal-if-stale) before running, so a due
 * backup fires at most once and a crashed owner's stale lease is re-armed. The
 * table is accessed at runtime via raw SQL in `lib/backups/lease.ts`; the Drizzle
 * declaration here exists so `db:generate` tracks the table (drift gate). Every
 * `*_at` column uses `withTimezone: true` to match the runtime `timestamptz`
 * type (PLAN §8 timestamp reconciliation).
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
