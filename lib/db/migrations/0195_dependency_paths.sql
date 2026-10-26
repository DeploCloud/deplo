ALTER TABLE "image_inventories" ADD COLUMN "deps_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_inventory_packages" ADD COLUMN "build_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_inventory_packages" ADD COLUMN "via" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "via" text DEFAULT '' NOT NULL;