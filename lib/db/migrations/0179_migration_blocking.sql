ALTER TABLE "migration_run_items" ADD COLUMN IF NOT EXISTS "blocking" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_runs" ADD COLUMN IF NOT EXISTS "blocking" integer DEFAULT 0 NOT NULL;
