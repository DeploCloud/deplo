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
  // The Cloudflare Tunnel the panel is served through; all null while it is off.
  panelTunnelHostname: text("panel_tunnel_hostname"),
  panelTunnelAccountId: text("panel_tunnel_account_id"),
  panelTunnelZoneId: text("panel_tunnel_zone_id"),
  panelTunnelId: text("panel_tunnel_id"),
  panelTunnelDnsRecordId: text("panel_tunnel_dns_record_id"),
  panelTunnelApiTokenEnc: text("panel_tunnel_api_token_enc"),
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
  // The version this process booted on, and who asked for the agent rollout that follows a panel update.
  bootedVersion: text("booted_version"),
  agentRolloutBy: text("agent_rollout_by"),
  // Offer canary (pre-release) versions of Deplo as updates. Never installs one by itself.
  canaryReleases: boolean("canary_releases").notNull().default(false),
  // ADR-0033: the id is re-minted every time the switch goes from off to on.
  usageReportsEnabled: boolean("usage_reports_enabled").notNull().default(true),
  usageInstanceId: text("usage_instance_id"),
  usageInstanceIdMintedAt: isoTimestamptz("usage_instance_id_minted_at"),
  usageReportSentAt: isoTimestamptz("usage_report_sent_at"),
  // ADR-0038: the instance switch, and when this machine last matched (or failed to reach OSV).
  securityUpdatesEnabled: boolean("security_updates_enabled")
    .notNull()
    .default(true),
  securityCheckedAt: isoTimestamptz("security_checked_at"),
  securityFailingSince: isoTimestamptz("security_failing_since"),
  kevFetchedAt: isoTimestamptz("kev_fetched_at"),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// ADR-0041: never cleared, and read with raw SQL by a later release before its migrations run.
export const passedUpdateStops = pgTable("passed_update_stops", {
  version: text("version").primaryKey(),
  passedAt: isoTimestamptz("passed_at").notNull(),
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
