ALTER TABLE "apps" ADD COLUMN "answer_slot" integer;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "answer_slot_next" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "answers_everywhere" boolean DEFAULT false NOT NULL;