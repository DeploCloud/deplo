-- The one-time move of every existing stack onto its Environment's own network.
-- Two scalars, no list: which stacks failed is in the Activity trail, and the
-- count is what the banner needs to say something is unfinished.
ALTER TABLE "instance_settings" ADD COLUMN "network_sweep_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "network_sweep_failed" integer DEFAULT 0 NOT NULL;
