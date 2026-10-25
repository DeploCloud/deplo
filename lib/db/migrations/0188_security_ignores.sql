CREATE TABLE "security_ignores" (
	"id" text PRIMARY KEY NOT NULL,
	"team_id" text NOT NULL,
	"app_id" text,
	"database_id" text,
	"vuln_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_ignores_subject_vuln" UNIQUE NULLS NOT DISTINCT("app_id","database_id","vuln_id")
);
--> statement-breakpoint
ALTER TABLE "security_ignores" ADD CONSTRAINT "security_ignores_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_ignores" ADD CONSTRAINT "security_ignores_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_ignores" ADD CONSTRAINT "security_ignores_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_ignores" ADD CONSTRAINT "security_ignores_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;