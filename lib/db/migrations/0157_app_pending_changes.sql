-- Config saved but not deployed yet, so the Environment and Settings tabs can say
-- so instead of leaving the change silently inert until someone redeploys.
ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "pending_changes_at" timestamp with time zone;
