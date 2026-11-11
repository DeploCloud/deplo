ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "sticky_sessions" boolean DEFAULT false NOT NULL;
