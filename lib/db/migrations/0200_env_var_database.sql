ALTER TABLE "env_vars" ADD COLUMN "database_id" text;--> statement-breakpoint
ALTER TABLE "env_vars" ADD CONSTRAINT "env_vars_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "env_vars_database_idx" ON "env_vars" USING btree ("database_id");