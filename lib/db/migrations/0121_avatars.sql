-- Profile pictures for people and teams, and two things that ride along with them.
--
-- A person's picture needs no column: `users.image` has been there since 0055,
-- required by Better Auth's user model and never written by deplo (the schema
-- comment says so). It stops being dead weight here. Teams get the twin, spelled
-- the same way and holding the same thing - a base64 image data-URI inline on the
-- row, exactly like an App's logo, because the dashboard CSP allows no remote host
-- and the bytes have to travel with the row.
--
-- `gravatar_enabled` is the switch for the OTHER half. On (the default, because a
-- picture nobody had to upload is the whole point) a person with no uploaded image
-- resolves to a Gravatar URL built from the sha256 of their address, and each
-- VIEWER's browser fetches it - the panel itself never dials out, so an instance
-- with no egress still works. Off, the data layer emits no gravatar URL at all and
-- nothing about anybody leaves the instance, which is the answer an operator who
-- self-hosts to stop talking to other people's servers is entitled to.
--
-- `deployments.creator_user_id` is who `creator` NAMES. That column is free text
-- and stays free text: it also carries a GitHub login for a webhook push, which
-- belongs to no deplo account. The id is the nullable half - set when a person in
-- a request asked for the deploy, NULL for a webhook and for every row that
-- predates this - so a deployment can show a face without the history rewriting
-- itself. ON DELETE SET NULL, like every other authorship FK here: deleting an
-- account must never take build history with it.
--
-- `memberships.switcher_position` is ONE PERSON's arrangement of the topbar team
-- switcher. It lives on the membership because the membership IS the (user, team)
-- junction the order is grained on - the same shape `team_app_order.position` has
-- - so there is no second table to keep in step and no stale row left behind when
-- somebody leaves a team. NULL means "never dragged", and those sort last in
-- creation order, which is exactly what everyone sees today.
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "image" text;--> statement-breakpoint

ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "gravatar_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint

ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "creator_user_id" text;--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT IF EXISTS "deployments_creator_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_creator_user_id_users_id_fk"
  FOREIGN KEY ("creator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "switcher_position" integer;
