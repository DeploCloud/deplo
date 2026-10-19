ALTER TABLE "users" ADD COLUMN "can_configure_traefik" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "traefik_labels_by" text;
--> statement-breakpoint
CREATE TABLE "app_traefik_labels" (
  "app_id" text NOT NULL CONSTRAINT "app_traefik_labels_app_id_apps_id_fk" REFERENCES "apps"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "value" text NOT NULL,
  CONSTRAINT "app_traefik_labels_app_id_key_pk" PRIMARY KEY ("app_id", "key")
);
