ALTER TABLE "instance_settings" DROP COLUMN "gravatar_enabled";--> statement-breakpoint
UPDATE "users" SET "image" = NULL WHERE "image" = 'gravatar';
