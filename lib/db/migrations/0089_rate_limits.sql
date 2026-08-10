-- Fixed-window rate-limit counters, durable.
--
-- They lived in a process-global `Map`, which fails in two ways that matter for
-- the thing they protect. A restart wiped every bucket, so anyone who could
-- make the control plane restart also reset the login-attempt counter for every
-- account at once. And the moment more than one instance serves the same
-- database, each holds its own Map and the effective limit is silently
-- multiplied by the instance count - for a hosted deplo that is not a
-- degradation, it is the limiter not working.
--
-- Postgres is already the only control-plane store, so this needs no Redis and
-- no new moving part: the whole limiter is one UPSERT that increments or resets
-- in a single statement, which also makes it atomic under concurrency in a way
-- the read-modify-write on the Map never was.
--
-- `key` is opaque and caller-chosen (`login:email:<addr>`, `2fa-step-up:<user>`,
-- ...). Nothing here is user-visible and nothing joins to it, so there is no FK
-- and no team scoping: a bucket outlives the row it was about, on purpose.

CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" text PRIMARY KEY,
  "count" integer NOT NULL,
  "reset_at" timestamptz NOT NULL
);
--> statement-breakpoint

-- The sweep deletes by expiry, and expired rows are the minority at any moment.
CREATE INDEX IF NOT EXISTS "rate_limits_reset_at_idx" ON "rate_limits" ("reset_at");
