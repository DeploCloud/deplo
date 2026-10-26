CREATE TABLE "security_pull_requests" (
	"app_id" text NOT NULL,
	"team_id" text NOT NULL,
	"package_name" text NOT NULL,
	"version" text NOT NULL,
	"number" integer NOT NULL,
	"url" text NOT NULL,
	"created_by" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "security_pull_requests_app_id_package_name_version_pk" PRIMARY KEY("app_id","package_name","version")
);
--> statement-breakpoint
ALTER TABLE "security_pull_requests" ADD CONSTRAINT "security_pull_requests_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_pull_requests" ADD CONSTRAINT "security_pull_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_pull_requests" ADD CONSTRAINT "security_pull_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;