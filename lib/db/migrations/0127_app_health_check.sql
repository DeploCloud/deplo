-- A health check per app, so the status dot tells the truth.
--
-- Deplo had one only for a database (generated) and for a server. An app was
-- "running" the moment its container was, which is not the same question, and it
-- is the question the other platforms answer. Flattened like resource_*: a nested
-- shape would be a JSONB column, and this schema has none.
ALTER TABLE "apps"
  ADD COLUMN IF NOT EXISTS "health_check_enabled" boolean DEFAULT false NOT NULL,
  -- 'http' | 'command'.
  ADD COLUMN IF NOT EXISTS "health_check_type" text,
  ADD COLUMN IF NOT EXISTS "health_check_path" text,
  ADD COLUMN IF NOT EXISTS "health_check_port" integer,
  ADD COLUMN IF NOT EXISTS "health_check_command" text,
  ADD COLUMN IF NOT EXISTS "health_check_interval_s" integer,
  ADD COLUMN IF NOT EXISTS "health_check_timeout_s" integer,
  ADD COLUMN IF NOT EXISTS "health_check_retries" integer,
  ADD COLUMN IF NOT EXISTS "health_check_start_period_s" integer;
