-- Each channel gets its OWN alert selection, and six more channels to select for.
--
-- `notification_alerts` was one decision per (team, alert), and every enabled
-- channel got the same set. Twelve channels in, that is the wrong shape: a team
-- room that wants every deploy outcome and an on-call phone that wants only the
-- failures is the normal case, not the exotic one. The channel joins the key.
--
-- The three-state rule is UNCHANGED, just one dimension wider. A row means the
-- team decided, `enabled` says which way, and an ABSENT row still falls back to
-- ALERT_META[key].defaultOn (lib/alerts.ts). So a channel nobody has ever opened
-- has no rows at all and lands exactly on DEFAULT_ALERTS - which is the whole
-- implementation of "a newly enabled channel starts on the catalogue defaults",
-- with nothing to seed and no write on the toggle - and an alert key added in a
-- later release still needs no backfill, now for all twelve channels at once.
--
-- The existing rows fan out to the SIX CHANNELS THAT ALREADY EXISTED, so nobody
-- loses an alert they had picked. The six new ones deliberately get no rows: a
-- team that has never heard of Lark has not decided anything about it, so it
-- starts on the catalogue defaults like any other freshly enabled channel.
--
-- Order matters three times over. The primary key has to go BEFORE the INSERT,
-- because six rows now share the (team_id, alert_key) it used to enforce.
-- `SET NOT NULL` has to come AFTER the DELETE that removes the old rows. And
-- reading the same table this writes is safe only because both statements key
-- off `channel IS NULL`: Postgres runs the SELECT against the snapshot taken
-- when the statement started, so the rows it inserts are not rows it re-reads.
ALTER TABLE "notification_alerts" DROP CONSTRAINT IF EXISTS "notification_alerts_team_id_alert_key_pk";
--> statement-breakpoint
ALTER TABLE "notification_alerts" ADD COLUMN IF NOT EXISTS "channel" text;
--> statement-breakpoint
INSERT INTO "notification_alerts" ("team_id", "channel", "alert_key", "enabled")
	SELECT a."team_id", c."channel", a."alert_key", a."enabled"
	FROM "notification_alerts" a
	CROSS JOIN (VALUES
		('push'), ('email'), ('discord'), ('webhook'), ('slack'), ('telegram')
	) AS c("channel")
	WHERE a."channel" IS NULL;
--> statement-breakpoint
DELETE FROM "notification_alerts" WHERE "channel" IS NULL;
--> statement-breakpoint
ALTER TABLE "notification_alerts" ALTER COLUMN "channel" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_alerts" ADD CONSTRAINT "notification_alerts_team_id_channel_alert_key_pk" PRIMARY KEY ("team_id","channel","alert_key");
--> statement-breakpoint
-- Six more channels, all beta. Every column carries a DEFAULT: the existing rows
-- are NOT NULL with none, so anything less would refuse to add.
--
-- Lark, Microsoft Teams and Mattermost are one incoming-webhook URL each, the
-- same shape as Discord and Slack. Microsoft Teams is the Power Automate
-- Workflows URL, not the Office 365 connector, which retired on 31 Mar 2026.
--
-- Gotify and ntfy are the two that are usually self-hosted, and both carry a
-- server address of their own. That address goes through the same
-- `assertSafeOutboundUrl` guard as every other outbound URL, which means public
-- https only: a Gotify on the LAN is refused, deliberately and with no escape
-- hatch, because the control plane dials these from a background loop with no
-- user behind it.
--
-- ntfy is the one channel whose destination is not a single URL - server and
-- topic are separate because the JSON publish API puts the topic in the BODY,
-- not the path. Pushover is the one with two credentials: the application token
-- and the user or group key, both encrypted.
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "lark_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "lark_webhook_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "msteams_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "msteams_webhook_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "mattermost_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "mattermost_webhook_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "gotify_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "gotify_url" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "gotify_token_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "ntfy_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "ntfy_base_url" text DEFAULT 'https://ntfy.sh' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "ntfy_topic" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "ntfy_token_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "pushover_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "pushover_token_enc" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN IF NOT EXISTS "pushover_user_key_enc" text DEFAULT '' NOT NULL;
