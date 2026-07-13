-- Variable authorship — "who added / who last touched this variable" — on the three
-- variable tables, plus the human identity behind an activity's free-text `actor`.
-- Authorship is METADATA, never a value: these columns are safe to project into a
-- DTO while `value_enc` stays write-only.
--
-- All nullable: the migrator runs at boot against live self-hosted DBs whose tables
-- are non-empty, so a NOT NULL add would fail.
--
-- The three variable tables get an `ON DELETE set null` FK — they are small, so the
-- constraint's validating scan is free, and a deleted user must not take their
-- variables with them. `activities.actor_user_id` gets NO FK, on purpose: the activity
-- log is an append-only AUDIT trail, and `ON DELETE SET NULL` would rewrite history
-- the day a user is deleted. `actor` is free text and not an FK for that same reason.
-- It is also the one table here that grows without bound, and `ADD CONSTRAINT` takes an
-- ACCESS EXCLUSIVE lock plus a validating scan of the whole log — at boot, since
-- migrations auto-apply in `instrumentation.ts`. An id that no longer resolves simply
-- renders "—"; the free-text `actor` name survives regardless.
--
-- DELIBERATELY NO BACKFILL. Migration 0012 backfilled folder ownership to the team
-- founder; that is exactly what must NOT happen here. Naming a user as the author of
-- a pre-existing secret they may never have touched is a fabricated audit claim —
-- and every `shared_env_vars` row that 0027 exploded out of the legacy groups has no
-- author to recover at all. Pre-existing rows keep NULL; the UI renders "—".
ALTER TABLE "env_vars" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "env_vars" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "instance_env_vars" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "instance_env_vars" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_env_vars" ADD CONSTRAINT "instance_env_vars_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_env_vars" ADD CONSTRAINT "instance_env_vars_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD CONSTRAINT "shared_env_vars_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_env_vars" ADD CONSTRAINT "shared_env_vars_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
