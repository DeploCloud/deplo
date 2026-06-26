CREATE TABLE "project_basic_auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_basic_auth_users" ADD CONSTRAINT "project_basic_auth_users_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_basic_auth_users_project_username_uq" ON "project_basic_auth_users" USING btree ("project_id","username");--> statement-breakpoint
CREATE INDEX "project_basic_auth_users_project_idx" ON "project_basic_auth_users" USING btree ("project_id");