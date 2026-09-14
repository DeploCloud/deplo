import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// schedulerLease is the cross-process mutex, driven by raw SQL in lib/backups/lease.ts; declared here only so db:generate tracks it.
export const schedulerLease = pgTable("scheduler_lease", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  // a lease older than the staleness window is reclaimable
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
