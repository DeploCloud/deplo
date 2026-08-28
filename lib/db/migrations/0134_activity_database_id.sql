ALTER TABLE "activities" ADD COLUMN "database_id" text REFERENCES "databases"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activities_database_idx" ON "activities" ("database_id");
