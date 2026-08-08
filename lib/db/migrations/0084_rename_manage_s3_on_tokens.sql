-- The half of the `manage_s3` rename that 0083 missed: API tokens.
--
-- 0083 renamed the capability in every table 0056 knew about, but
-- `api_token_capabilities` was added AFTER 0056, so it was not on that list and
-- the rename walked straight past it.
--
-- The consequence is silent, which is what makes it worth a migration of its
-- own rather than a note. A token stores its capabilities as rows; the read
-- filters them through the current catalogue (`inCatalogOrder`), and `manage_s3`
-- is no longer in it — so the row is DROPPED, not translated.
-- LEGACY_CAPABILITY_EXPANSION only runs on capabilities arriving as input, and
-- these never arrive: they are already stored. So a token minted before the
-- upgrade quietly loses the power to manage backup destinations, its automation
-- starts failing `requireCapability("manage_backup_destinations")`, and the
-- token page shows the box unticked with nothing to explain it.
--
-- 0077 and 0080 deliberately skip this table, and that is not a precedent
-- against this: those are BACKFILLS, and widening a secret someone already
-- minted is exactly what a backfill must not do. This is a RENAME. It grants
-- nothing new — it keeps a token doing what its owner ticked.
INSERT INTO "api_token_capabilities" ("token_id", "capability")
SELECT DISTINCT t."token_id", 'manage_backup_destinations' FROM "api_token_capabilities" t
  WHERE t."capability" = 'manage_s3'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "api_token_capabilities" WHERE "capability" = 'manage_s3';
