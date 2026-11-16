ALTER TABLE "apps" ADD COLUMN "entrance_slot" integer;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "answers_everywhere" boolean DEFAULT false NOT NULL;