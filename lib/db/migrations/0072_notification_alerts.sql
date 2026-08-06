-- Notifications stop being a settings page and become a feature.
--
-- Until now `events` was five boolean columns and nothing on earth read them:
-- the deploy pipeline, the backup scheduler and the health writer all finished
-- their work without telling anybody. This migration is the storage half of
-- fixing that - a catalogue of ~32 alerts, six channels, and a per-team email
-- transport.
--
-- The five booleans move OUT into a child table. Thirty-two columns would make
-- every future alert a migration, and the repo's own rule is explicit: a list is
-- a junction table, never a column per item and never JSONB.
--
-- `enabled` is a real column rather than "a row means subscribed", because THREE
-- states are real: on, off, and never said. A team that unticks a default-on
-- alert has to stay distinguishable from a team that has never opened the page -
-- and an alert key added in a later release must land on its catalogue default
-- for every existing team with no backfill. Absent row = ALERT_META[key].defaultOn
-- (lib/alerts.ts), which is the same "missing row = default" rule the settings
-- row itself already follows.
CREATE TABLE IF NOT EXISTS "notification_alerts" (
	"team_id" text NOT NULL,
	"alert_key" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "notification_alerts_team_id_alert_key_pk" PRIMARY KEY("team_id","alert_key"),
	CONSTRAINT "notification_alerts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade
);
--> statement-breakpoint
-- Carry the five existing switches over, so nobody loses an alert they had.
-- `high_resource_usage` was ONE switch over two very different situations - a box
-- that is busy and a box that is about to stop working - so it seeds both keys.
-- They can be separated now, which is the point of splitting them.
INSERT INTO "notification_alerts" ("team_id", "alert_key", "enabled")
	SELECT "team_id", 'deployment_failed', "deployment_failed" FROM "notification_settings"
	UNION ALL SELECT "team_id", 'deployment_succeeded', "deployment_succeeded" FROM "notification_settings"
	UNION ALL SELECT "team_id", 'server_offline', "server_offline" FROM "notification_settings"
	UNION ALL SELECT "team_id", 'server_resources_high', "high_resource_usage" FROM "notification_settings"
	UNION ALL SELECT "team_id", 'server_disk_low', "high_resource_usage" FROM "notification_settings"
	UNION ALL SELECT "team_id", 'deplo_update_available', "update_available" FROM "notification_settings"
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "deployment_failed";
--> statement-breakpoint
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "deployment_succeeded";
--> statement-breakpoint
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "server_offline";
--> statement-breakpoint
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "high_resource_usage";
--> statement-breakpoint
ALTER TABLE "notification_settings" DROP COLUMN IF EXISTS "update_available";
--> statement-breakpoint
-- The new channels. Every column carries a DEFAULT: the existing rows are all
-- NOT NULL with no default, so anything less would refuse to add.
--
-- There is deliberately no `smtp_secure`: implicit TLS is port 465 and nothing
-- else, which is nodemailer's own rule and one fewer knob on the first-run path.
-- Slack is an incoming-webhook URL, the same shape as Discord - a bot token
-- would need an app manifest, an OAuth install and a channel lookup, which is a
-- feature, not a channel.
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "email_from" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "email_provider" text DEFAULT 'smtp' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "smtp_host" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "smtp_port" integer DEFAULT 587 NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "smtp_user" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "smtp_password_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "resend_api_key_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "slack_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "slack_webhook_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "telegram_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "telegram_bot_token_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "telegram_chat_id" text DEFAULT '' NOT NULL;
--> statement-breakpoint
-- Web push (beta). The VAPID keypair identifies THIS Deplo to every browser push
-- service, so it is instance-wide - one keypair on the singleton row - and the
-- private half is encrypted like every other secret. Both are NULL until the
-- first person subscribes; `ensureVapidKeys` mints them then, so an instance
-- that never uses push never holds a key.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "vapid_public_key" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "vapid_private_key_enc" text;
--> statement-breakpoint
-- One row per browser that opted in, per team. Per USER because a push
-- subscription is a device's, not a team's; per TEAM because the alert is the
-- team's and the same person can hold two. The browser-issued endpoint IS the
-- identity, so it carries the PK - nothing to mint - and both FKs cascade, which
-- is the whole cleanup story when an account or a team goes.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
	"team_id" text NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "push_subscriptions_team_id_user_id_endpoint_pk" PRIMARY KEY("team_id","user_id","endpoint"),
	CONSTRAINT "push_subscriptions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade,
	CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_subscriptions_team_idx" ON "push_subscriptions" ("team_id");
