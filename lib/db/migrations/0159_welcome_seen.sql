-- The first-run welcome is shown once per INSTANCE, not once per URL flag: the
-- wizard's `?welcome=1` is gone after a reload, so the owner could never see it.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "welcome_seen_at" timestamp with time zone;
