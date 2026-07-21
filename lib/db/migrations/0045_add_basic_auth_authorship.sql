-- Authorship on HTTP Basic Auth credentials — "who set this login up, and who
-- last rotated it". The Access page reads these to answer the one question a
-- shared credential always raises: who put it there, and when was it last touched.
--
-- Exactly the shape migration 0029 gave the variable tables, for exactly the same
-- reasons:
--
--  * Nullable. The migrator runs at boot against live self-hosted DBs whose
--    `app_basic_auth_users` is non-empty, so a NOT NULL add would fail.
--  * `ON DELETE SET NULL` FKs. The table is small, so the constraint's validating
--    scan is free, and deleting a user must not delete the logins they created —
--    that would silently drop a live basic-auth middleware.
--  * NO BACKFILL. Naming a user as the author of a credential they may never have
--    touched is a fabricated audit claim. Pre-existing rows keep NULL and the UI
--    renders "—".
--
-- Authorship is METADATA, never a value: safe to project into a DTO while
-- `password_enc` stays out of it.
ALTER TABLE "app_basic_auth_users" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "app_basic_auth_users" ADD COLUMN "updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "app_basic_auth_users" ADD CONSTRAINT "app_basic_auth_users_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_basic_auth_users" ADD CONSTRAINT "app_basic_auth_users_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
