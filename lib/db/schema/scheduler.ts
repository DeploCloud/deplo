import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const schedulerLease = pgTable("scheduler_lease", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
