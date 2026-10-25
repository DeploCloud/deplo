CREATE TABLE "image_inventories" (
	"image_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"distro_id" text DEFAULT '' NOT NULL,
	"distro_version" text DEFAULT '' NOT NULL,
	"working_dir" text DEFAULT '' NOT NULL,
	"scanner_version" text DEFAULT '' NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_inventory_packages" (
	"image_id" text NOT NULL,
	"purl" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"version" text NOT NULL,
	CONSTRAINT "image_inventory_packages_image_id_purl_location_pk" PRIMARY KEY("image_id","purl","location")
);
--> statement-breakpoint
CREATE TABLE "kev_cves" (
	"cve_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "osv_affected" (
	"vuln_id" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"fixed_version" text,
	"cve" text,
	"severity" text,
	"cvss_tenths" integer,
	"summary" text DEFAULT '' NOT NULL,
	"modified" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	CONSTRAINT "osv_affected_vuln_id_ecosystem_name_pk" PRIMARY KEY("vuln_id","ecosystem","name")
);
--> statement-breakpoint
CREATE TABLE "security_findings" (
	"server_id" text NOT NULL,
	"workload_id" text NOT NULL,
	"service" text NOT NULL,
	"vuln_id" text NOT NULL,
	"ecosystem" text NOT NULL,
	"package_name" text NOT NULL,
	"installed_version" text NOT NULL,
	"fixed_version" text,
	"location" text DEFAULT '' NOT NULL,
	"level" text NOT NULL,
	"fix" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"alerted_at" timestamp with time zone,
	CONSTRAINT "security_findings_pk" PRIMARY KEY("server_id","workload_id","service","vuln_id","ecosystem","package_name","installed_version")
);
--> statement-breakpoint
CREATE TABLE "workload_images" (
	"server_id" text NOT NULL,
	"workload_id" text NOT NULL,
	"service" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"team_id" text NOT NULL,
	"app_id" text,
	"preview_id" text,
	"database_id" text,
	"image_ref" text NOT NULL,
	"image_id" text NOT NULL,
	"repo_digest" text DEFAULT '' NOT NULL,
	"running" boolean NOT NULL,
	"registry_status" text,
	"registry_digest" text,
	"newer_tag" text,
	"registry_checked_at" timestamp with time zone,
	"seen_at" timestamp with time zone NOT NULL,
	"checked_at" timestamp with time zone,
	CONSTRAINT "workload_images_server_id_workload_id_service_pk" PRIMARY KEY("server_id","workload_id","service")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "security_updates_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "security_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "security_failing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "kev_fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "image_inventory_packages" ADD CONSTRAINT "image_inventory_packages_image_id_image_inventories_image_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."image_inventories"("image_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_workload_fk" FOREIGN KEY ("server_id","workload_id","service") REFERENCES "public"."workload_images"("server_id","workload_id","service") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_images" ADD CONSTRAINT "workload_images_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_images" ADD CONSTRAINT "workload_images_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_images" ADD CONSTRAINT "workload_images_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_images" ADD CONSTRAINT "workload_images_preview_id_app_previews_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."app_previews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workload_images" ADD CONSTRAINT "workload_images_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workload_images_team_idx" ON "workload_images" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "workload_images_image_idx" ON "workload_images" USING btree ("image_id");