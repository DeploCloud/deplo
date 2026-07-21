-- Deleting an app's PRIMARY domain used to leave two lies behind: the app kept
-- `production_url` pointing at the hostname that was just removed (the app card's
-- subtitle and the title-bar link read it), and no remaining domain inherited the
-- primary flag — so the app was left primary-less, its canonical host decided by
-- whatever row Postgres happened to return first.
--
-- `removeDomain` now promotes an heir and re-derives the URL. This heals the rows
-- that drifted before that fix, since nothing else ever rewrites `production_url`
-- outside a deploy (an app whose domain is gone may never deploy again).
--
-- The succession heuristic (same service, then same port) can't be replayed here:
-- the removed domain is long gone, so the oldest remaining domain gets the crown.
--
-- Idempotent — re-running changes nothing once every app is consistent.
-- Hand-authored: the committed drizzle snapshots stop at 0014, so
-- `drizzle-kit generate` can't diff against an up-to-date base.

-- 1. An app that still has domains must have exactly one primary.
UPDATE "domains" SET "is_primary" = true WHERE "id" IN (
  SELECT DISTINCT ON (d."app_id") d."id"
  FROM "domains" d
  WHERE NOT EXISTS (
    SELECT 1 FROM "domains" p WHERE p."app_id" = d."app_id" AND p."is_primary"
  )
  ORDER BY d."app_id", d."created_at", d."id"
);
--> statement-breakpoint
-- 2. Re-derive the canonical URL from that primary — NULL when the app has no
--    domain at all, so the UI falls back to "No domain yet". The scheme mirrors
--    domainScheme(): only the cert-less `none` provider is served plain HTTP
--    (a NULL provider is a pre-field row, which routes as letsencrypt).
UPDATE "apps" a SET "production_url" = (
  SELECT CASE WHEN coalesce(d."cert_provider", 'letsencrypt') = 'none'
              THEN 'http://' ELSE 'https://' END || d."name"
  FROM "domains" d
  WHERE d."app_id" = a."id"
  ORDER BY d."is_primary" DESC, d."created_at", d."id"
  LIMIT 1
)
WHERE a."production_url" IS DISTINCT FROM (
  SELECT CASE WHEN coalesce(d."cert_provider", 'letsencrypt') = 'none'
              THEN 'http://' ELSE 'https://' END || d."name"
  FROM "domains" d
  WHERE d."app_id" = a."id"
  ORDER BY d."is_primary" DESC, d."created_at", d."id"
  LIMIT 1
);
