-- Channels stop being twelve fixed slots and become N INSTANCES per team.
--
-- One column group per type meant exactly one Discord room, one on-call phone,
-- one email address. Two rooms is the normal case, not the exotic one, so the
-- row stops being the TEAM's channel set and becomes ONE channel: an id, a
-- kind, an optional name the team chooses, and the fields that kind uses. Any
-- kind may repeat, browser push included - two push instances notify the same
-- device twice, which is the owner's call and deliberately has no exception.
--
-- Still flat columns, still no JSONB: a channel is a fixed set of named
-- heterogeneous fields, not a list, which is the same reason the settings row
-- was flat. Twelve child tables would pay a whole table for {webhook_url} five
-- times over and turn the dispatcher's one hot SELECT into twelve joins. Three
-- columns are shared because the CONCEPT repeats: `url` is the outbound
-- endpoint (the five chat webhooks, the generic webhook, the Gotify and ntfy
-- servers), `target` is the addressee inside it (telegram chat id, ntfy topic,
-- email To:), and `secret_enc`/`secret2_enc` are the credentials. Email uses
-- both secret slots, so switching transport never strands a stored credential.
CREATE TABLE IF NOT EXISTS "notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"url" text DEFAULT '' NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"secret_enc" text DEFAULT '' NOT NULL,
	"secret2_enc" text DEFAULT '' NOT NULL,
	"email_from" text DEFAULT '' NOT NULL,
	"email_provider" text DEFAULT 'resend' NOT NULL,
	"smtp_host" text DEFAULT '' NOT NULL,
	"smtp_port" integer DEFAULT 587 NOT NULL,
	"smtp_user" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notification_channels_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_channels_team_created_idx" ON "notification_channels" ("team_id","created_at");
--> statement-breakpoint
-- Every type a team had ENABLED or CONFIGURED becomes an instance, keeping its
-- config, its enabled flag and (below) its alert selection. A type that is
-- neither loses nothing: every one of its columns is still at the default it
-- shipped with, and a fresh instance of that kind starts on the catalogue
-- defaults regardless.
--
-- Three things in here are not decoration:
--
--  * The `ord` offset on created_at. `now()` is the TRANSACTION's clock, so
--    without it all twelve rows carry the same timestamp and a migrated team's
--    list comes out in whatever order the planner felt like. The offset lands
--    them in ALL_CHANNELS order, which is the order the page showed yesterday.
--
--  * The CASE on ntfy. `ntfy_base_url` is NOT NULL DEFAULT 'https://ntfy.sh',
--    so EVERY existing row carries one - taking that as evidence of
--    configuration would mint an ntfy channel for every team that has never
--    heard of ntfy. The address only counts once the topic, the token or the
--    switch says somebody touched it, and then it comes along.
--
--  * What is NOT in the WHERE. `email_provider` and `smtp_port` are also NOT
--    NULL with defaults, so they are always set and prove nothing either.
INSERT INTO "notification_channels" (
	"id", "team_id", "kind", "name", "enabled", "url", "target",
	"secret_enc", "secret2_enc", "email_from", "email_provider",
	"smtp_host", "smtp_port", "smtp_user", "created_at"
)
	SELECT
		'chan_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
		s."team_id", c."kind", '', c."enabled", c."url", c."target",
		c."secret_enc", c."secret2_enc", c."email_from", c."email_provider",
		c."smtp_host", c."smtp_port", c."smtp_user",
		now() + (interval '1 millisecond' * c."ord")
	FROM "notification_settings" s
	CROSS JOIN LATERAL (VALUES
		(1,  'push',       s."push_enabled",       ''::text,                   ''::text,             ''::text,                   ''::text,                  ''::text,       'resend'::text,     ''::text,      587,           ''::text),
		(2,  'email',      s."email_enabled",      '',                         s."email_address",    s."smtp_password_enc",      s."resend_api_key_enc",    s."email_from", s."email_provider", s."smtp_host", s."smtp_port", s."smtp_user"),
		(3,  'discord',    s."discord_enabled",    s."discord_webhook_url",    '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(4,  'webhook',    s."webhook_enabled",    s."webhook_url",            '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(5,  'slack',      s."slack_enabled",      s."slack_webhook_url",      '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(6,  'telegram',   s."telegram_enabled",   '',                         s."telegram_chat_id", s."telegram_bot_token_enc", '',                        '',             'resend',           '',            587,           ''),
		(7,  'lark',       s."lark_enabled",       s."lark_webhook_url",       '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(8,  'msteams',    s."msteams_enabled",    s."msteams_webhook_url",    '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(9,  'gotify',     s."gotify_enabled",     s."gotify_url",             '',                   s."gotify_token_enc",       '',                        '',             'resend',           '',            587,           ''),
		(10, 'ntfy',       s."ntfy_enabled",
			CASE WHEN s."ntfy_enabled" OR s."ntfy_topic" <> '' OR s."ntfy_token_enc" <> ''
			     THEN s."ntfy_base_url" ELSE '' END,
			s."ntfy_topic", s."ntfy_token_enc", '', '', 'resend', '', 587, ''),
		(11, 'mattermost', s."mattermost_enabled", s."mattermost_webhook_url", '',                   '',                         '',                        '',             'resend',           '',            587,           ''),
		(12, 'pushover',   s."pushover_enabled",   '',                         '',                   s."pushover_token_enc",     s."pushover_user_key_enc", '',             'resend',           '',            587,           '')
	) AS c("ord", "kind", "enabled", "url", "target", "secret_enc", "secret2_enc", "email_from", "email_provider", "smtp_host", "smtp_port", "smtp_user")
	WHERE c."enabled"
		OR c."url" <> ''
		OR c."target" <> ''
		OR c."secret_enc" <> ''
		OR c."secret2_enc" <> ''
		OR c."email_from" <> ''
		OR c."smtp_host" <> ''
		OR c."smtp_user" <> '';
--> statement-breakpoint
-- The alerts follow their channel by ID, not by type name. Same repivot as
-- 0073, same order and for the same reasons: the primary key goes BEFORE the
-- backfill (two instances of one kind now share the (team, channel) it used to
-- enforce), and SET NOT NULL goes AFTER the DELETE.
--
-- The three-state rule is UNCHANGED. A row means the team decided, `enabled`
-- says which way, and an ABSENT row still falls back to ALERT_META[key].defaultOn
-- (lib/alerts.ts). So a brand-new instance has no rows at all and lands exactly
-- on DEFAULT_ALERTS - which is the whole implementation of "a new channel starts
-- on the catalogue defaults", with nothing to seed and no write on create - and
-- an alert key added in a later release still needs no backfill.
--
-- `team_id` goes away with `channel`: the cascade comes back through the
-- channel, which is also what makes deleting an instance take its selection with
-- it without a line of application code.
ALTER TABLE "notification_alerts" DROP CONSTRAINT IF EXISTS "notification_alerts_team_id_channel_alert_key_pk";
--> statement-breakpoint
ALTER TABLE "notification_alerts" ADD COLUMN IF NOT EXISTS "channel_id" text;
--> statement-breakpoint
UPDATE "notification_alerts" a
	SET "channel_id" = c."id"
	FROM "notification_channels" c
	WHERE c."team_id" = a."team_id" AND c."kind" = a."channel";
--> statement-breakpoint
-- A decision about a type that never became an instance. There is nothing left
-- for it to be a decision ABOUT.
DELETE FROM "notification_alerts" WHERE "channel_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "notification_alerts" ALTER COLUMN "channel_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_alerts" DROP CONSTRAINT IF EXISTS "notification_alerts_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "notification_alerts" DROP COLUMN IF EXISTS "channel";
--> statement-breakpoint
ALTER TABLE "notification_alerts" DROP COLUMN IF EXISTS "team_id";
--> statement-breakpoint
ALTER TABLE "notification_alerts" ADD CONSTRAINT "notification_alerts_channel_id_alert_key_pk" PRIMARY KEY ("channel_id","alert_key");
--> statement-breakpoint
ALTER TABLE "notification_alerts" ADD CONSTRAINT "notification_alerts_channel_id_notification_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id") ON DELETE cascade;
--> statement-breakpoint
-- Everything it held is now an instance. Nothing team-wide is left in it.
DROP TABLE IF EXISTS "notification_settings";
