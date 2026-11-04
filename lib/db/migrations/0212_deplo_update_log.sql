CREATE TABLE "deplo_update_log" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"outcome" text NOT NULL,
	"from_version" text NOT NULL,
	"to_version" text NOT NULL,
	"actor" text,
	"reason" text,
	"log_path" text,
	"at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "deplo_update_log_at_idx" ON "deplo_update_log" USING btree ("at");