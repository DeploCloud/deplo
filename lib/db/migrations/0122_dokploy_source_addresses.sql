-- Where Deplo dials a machine it is importing FROM, remembered across attempts.
--
-- The address of the other platform's own host is DERIVED from the panel's URL,
-- which is right only when the panel is served straight off that machine on a
-- name that resolves to it. Behind Cloudflare, any CDN, a reverse proxy on
-- another box or a tunnel, it is the proxy's address and the agent is
-- unreachable at it. The wizard lets somebody correct that, and the correction
-- landed on the SERVER row - which is removed at the end of every attempt, on
-- purpose, because a migration source is not a server anyone keeps.
--
-- So Deplo learned the right address and threw it away, every cycle: revert,
-- re-register at the panel's name, correct it again. Observed four times in one
-- evening on one instance.
--
-- Keyed by the SOURCE, not by the server row, because that is what the knowledge
-- is about: this Dokploy, this machine of it, is reached here. `source_id` is
-- Dokploy's own machine id, empty string for the host Dokploy itself runs on -
-- the same key the import's server map and cutover already use for it.
CREATE TABLE IF NOT EXISTS "dokploy_source_addresses" (
  "team_id" text NOT NULL REFERENCES "teams"("id") ON DELETE CASCADE,
  "source_url" text NOT NULL,
  "source_id" text NOT NULL,
  "address" text NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "dokploy_source_addresses_pkey" PRIMARY KEY ("team_id","source_url","source_id")
);
