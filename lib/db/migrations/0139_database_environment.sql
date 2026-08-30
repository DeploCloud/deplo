-- A managed database gets a placement, exactly like an App: it lives in an
-- Environment (and so on that Environment's network), or nowhere in particular
-- (and so on its team's). NULL is the pre-existing state; the boot sweep derives
-- a placement for the rows that only one Environment references.
ALTER TABLE "databases" ADD COLUMN "environment_id" text;--> statement-breakpoint
ALTER TABLE "databases" ADD CONSTRAINT "databases_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "databases_environment_idx" ON "databases" USING btree ("environment_id");
