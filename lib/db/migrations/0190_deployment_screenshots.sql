CREATE TABLE "deployment_screenshots" (
	"deployment_id" text PRIMARY KEY NOT NULL,
	"light" "bytea" NOT NULL,
	"dark" "bytea",
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "screenshots_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment_screenshots" ADD CONSTRAINT "deployment_screenshots_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;