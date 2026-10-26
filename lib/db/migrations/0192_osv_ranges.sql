CREATE TABLE "osv_ranges" (
	"vuln_id" text NOT NULL,
	"ecosystem" text NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	"introduced" text NOT NULL,
	"fixed" text,
	"last_affected" text,
	CONSTRAINT "osv_ranges_pk" PRIMARY KEY("vuln_id","ecosystem","name","seq")
);
--> statement-breakpoint
ALTER TABLE "osv_ranges" ADD CONSTRAINT "osv_ranges_affected_fk" FOREIGN KEY ("vuln_id","ecosystem","name") REFERENCES "public"."osv_affected"("vuln_id","ecosystem","name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "osv_affected" DROP COLUMN "fixed_version";--> statement-breakpoint
-- Cached advisories carry one fix for every release line: read them again with their ranges,
-- and match every image on the next tick so no finding keeps a fix from another line.
DELETE FROM "osv_affected";--> statement-breakpoint
UPDATE "instance_settings" SET "security_checked_at" = NULL;
