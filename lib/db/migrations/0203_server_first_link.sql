-- A server's first verified agent link: never cleared, and never dialed after it (ADR-0041).
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "first_linked_at" timestamp with time zone;
