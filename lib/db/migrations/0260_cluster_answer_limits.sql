ALTER TABLE "clusters" ADD COLUMN "answer_max_connections" integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "answer_max_waiting" integer DEFAULT 128 NOT NULL;