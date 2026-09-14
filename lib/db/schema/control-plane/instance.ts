import { pgTable, text, integer, boolean, index } from "drizzle-orm/pg-core";

import { isoTimestamptz } from "../columns";
import { users } from "./identity";

// monitoringSettings - singleton, instance-wide: whether the control plane keeps a metrics history.
export const monitoringSettings = pgTable("monitoring_settings", {
  // Always `'default'`. The row is a singleton; the PK exists to enforce that.
  id: text("id").primaryKey().default("default"),
  // Keep a rolling in-memory metrics history per server on the control plane.
  saveMetrics: boolean("save_metrics").notNull(),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// instanceSettings - singleton instance settings, shaped like {@link monitoringSettings}.
export const instanceSettings = pgTable("instance_settings", {
  // Always `'default'`. The row is a singleton; the PK exists to enforce that.
  id: text("id").primaryKey().default("default"),
  // The instance owner. NULL means "unowned".
  ownerUserId: text("owner_user_id").references(() => users.id),
  // The address this Deplo answers on (`https://deplo.example.com`), as the
  // operator set it in Settings → Deplo.
  panelUrl: text("panel_url"),
  // Whether the generated `deplo-<hex>.nip.io` backup route is turned off. An
  // advanced opt-out: with it off, a domain that stops answering leaves
  // `deplo recover panel-address` on the host as the only way back in.
  panelFallbackDisabled: boolean("panel_fallback_disabled")
    .notNull()
    .default(false),
  // The VAPID keypair that identifies THIS Deplo to every browser push service
  // (beta). NULL until then; the private half is encrypted like every other
  // secret.
  vapidPublicKey: text("vapid_public_key"),
  vapidPrivateKeyEnc: text("vapid_private_key_enc"),
  // How far back the log viewer's time range may reach, in DAYS. Instance-wide
  // because the logs live on the HOST, which several teams share.
  logMaxDays: integer("log_max_days").notNull().default(7),
  // Whether a person with no uploaded picture falls back to their Gravatar. Off
  // by default: on, every member's browser hands gravatar.com their IP and a
  // hash of their address, which is not a thing to opt anyone into for them.
  gravatarEnabled: boolean("gravatar_enabled").notNull().default(false),
  // When the one-time network-isolation sweep finished, and how many stacks it
  // could not move. NULL ⇒ it has not run on this instance yet.
  networkSweepAt: isoTimestamptz("network_sweep_at"),
  networkSweepFailed: integer("network_sweep_failed").notNull().default(0),
  // The platform this instance is taking the machine back from - `'dokploy'` /
  // `'coolify'`, NULL on an ordinary install. Seeded at boot from the installer's
  // `DEPLO_TAKEOVER`, because only the installer can see the other platform.
  takeoverPlatform: text("takeover_platform"),
  // `'pending'` | `'ready'` | `'failed'` | `'done'` | `'removing'` | `'removed'` | `'cancelled'`.
  takeoverState: text("takeover_state"),
  // Why the last cutover rolled back, verbatim from the installer. NULL otherwise.
  takeoverError: text("takeover_error"),
  // The migration run that carried the machine over, for the report to link.
  takeoverRunId: text("takeover_run_id"),
  // When a request first reached the panel from something other than loopback.
  // NULL while only the installer has ever talked to it, which is what tells the
  // installer that its port is not reachable and another way in is needed.
  takeoverSeenExternalAt: isoTimestamptz("takeover_seen_external_at"),
  // When the first-run welcome was shown to the instance owner. NULL ⇒ nobody has
  // seen it yet, so their next visit to the Overview opens it.
  welcomeSeenAt: isoTimestamptz("welcome_seen_at"),
  updatedAt: isoTimestamptz("updated_at").notNull(),
});

// rateLimits - fixed-window counters for the sensitive paths; joined to nothing on purpose.
export const rateLimits = pgTable(
  "rate_limits",
  {
    // Opaque, caller-chosen: `login:email:<addr>`, `2fa-step-up:<userId>`, ...
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    // When the window ends. A row past it is treated as absent, then reused.
    resetAt: isoTimestamptz("reset_at").notNull(),
  },
  (t) => [index("rate_limits_reset_at_idx").on(t.resetAt)],
);
