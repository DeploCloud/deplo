-- An instance admin let the update stop pass without this server (ADR-0041); its apps and settings stay.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "left_behind_at" timestamp with time zone;
