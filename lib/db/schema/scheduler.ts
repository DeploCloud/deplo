// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * The cross-process backup-scheduler mutex. The table is accessed at runtime via
 * raw SQL in `lib/backups/lease.ts`; the Drizzle declaration here exists so
 * `db:generate` tracks the table (drift gate).
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
