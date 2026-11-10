-- Which member holds which release image of a cluster App, and how far a copy has got (spec #176).
CREATE TABLE IF NOT EXISTS "cluster_image_copies" (
	"app_id" text NOT NULL,
	"image_ref" text NOT NULL,
	"server_id" text NOT NULL,
	"state" text NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cluster_image_copies_app_id_image_ref_server_id_pk" PRIMARY KEY("app_id","image_ref","server_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_image_copies" ADD CONSTRAINT "cluster_image_copies_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cluster_image_copies" ADD CONSTRAINT "cluster_image_copies_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cluster_image_copies_server_idx" ON "cluster_image_copies" USING btree ("server_id");
