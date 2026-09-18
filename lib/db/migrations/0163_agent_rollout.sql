-- A panel update carries the fleet with it: the new panel notices its own version
-- changed at boot and updates every agent behind it, signed by whoever clicked.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "booted_version" text;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "agent_rollout_by" text;
