ALTER TABLE "image_inventories" ADD COLUMN "direct_read" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "image_inventory_packages" ADD COLUMN "direct" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "osv_affected" ADD COLUMN "conditional" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "security_findings" ADD COLUMN "direct" boolean;--> statement-breakpoint
UPDATE "osv_affected" SET "modified" = '';--> statement-breakpoint
UPDATE "instance_settings" SET "security_checked_at" = NULL;
