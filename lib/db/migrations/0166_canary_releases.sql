-- Opt-in canary (pre-release) updates: the panel's own, and each server agent's.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "canary_releases" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_canary" boolean DEFAULT false NOT NULL;
