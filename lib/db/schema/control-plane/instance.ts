import { pgTable, text, integer, boolean, index } from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { users } from "./identity";

export const monitoringSettings = pgTable("monitoring_settings", {
  id: text("id").primaryKey().default("default"),
  saveMetrics: boolean("save_metrics").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

export const instanceSettings = pgTable("instance_settings", {
  id: text("id").primaryKey().default("default"),
  ownerUserId: text("owner_user_id").references(() => users.id),
  panelUrl: text("panel_url"),
  panelFallbackDisabled: boolean("panel_fallback_disabled")
    .notNull()
    .default(false),
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKeyEnc: text("vapid_private_key_enc"),
  logMaxDays: integer("log_max_days").notNull().default(7),
  gravatarEnabled: boolean("gravatar_enabled").notNull().default(false),
  networkSweepAt: isoTimestamptz("network_sweep_at"),
  networkSweepFailed: integer("network_sweep_failed").notNull().default(0),
  takeoverPlatform: text("takeover_platform"),
  takeoverState: text("takeover_state"),
  takeoverError: text("takeover_error"),
  takeoverRunId: text("takeover_run_id"),
  takeoverSeenExternalAt: isoTimestamptz("takeover_seen_external_at"),
  welcomeSeenAt: isoTimestamptz("welcome_seen_at"),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    resetAt: isoTimestamptz("reset_at").notNull(),
  },
  (t) => [index("rate_limits_reset_at_idx").on(t.resetAt)],
);
