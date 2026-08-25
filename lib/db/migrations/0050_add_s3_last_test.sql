-- The last "Test connection" verdict for an S3 destination.
--
-- Testing a destination persisted only `status`, so a card sitting on a red
-- "Error" badge could not say WHY, and the failure detail existed nowhere: the
-- mutation returned the destination whatever the agent's verdict was, which is
-- also why the UI toasted success on a probe that had just failed.
--
-- Four flat columns (no JSONB - the probe sequence and the equivalent CLI
-- commands are DERIVED from these plus the destination's own coordinates, so
-- there is nothing nested to store):
--   last_test_at         when the probe ran; NULL ⇒ never tested
--   last_test_error      the agent's verbatim message; NULL/'' ⇒ it passed
--   last_test_server_id  which server's agent served it (any backup-capable one
--                        can, so this is not derivable) - SET NULL, because
--                        removing a server must not delete a destination
--   last_test_ms         how long the probe took, for the log header
ALTER TABLE "s3_destination" ADD COLUMN "last_test_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "last_test_error" text;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "last_test_server_id" text;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD COLUMN "last_test_ms" integer;--> statement-breakpoint
ALTER TABLE "s3_destination" ADD CONSTRAINT "s3_destination_last_test_server_id_servers_id_fk" FOREIGN KEY ("last_test_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The SET NULL above must not sequentially scan s3_destination on every server
-- removal (same reason 0047 indexed apps.created_by_user_id).
CREATE INDEX IF NOT EXISTS "s3_destination_last_test_server_idx" ON "s3_destination" ("last_test_server_id");
