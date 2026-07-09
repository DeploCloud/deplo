-- Framework presets were removed (the build methods auto-detect the stack), and
-- the Heroku/Paketo buildpack build methods were dropped. Purge their columns:
--   - services.framework                          (per-service framework preset)
--   - service_build.framework                     (build-config framework preset)
--   - service_build_method_settings.heroku_version (Heroku builder image tag)
--
-- Data migration: service_build.framework seeded runtime_version with the
-- framework's default language version, so NON-Node services stored a
-- Python/Go/Rust/PHP version (e.g. "3.12", "1.22"). Node is the only pinnable
-- runtime now, and the build path labels every stored runtime_version as "node"
-- (NIXPACKS_NODE_VERSION / RAILPACK_NODE_VERSION) — so a surviving non-Node value
-- would be mis-read as a Node major (majorVersion("3.12") = "3" ⇒ node:3, a
-- broken build). Clear those rows here, WHILE the framework column still exists,
-- so redeploys fall back to auto-detection. Guarded + IF EXISTS so re-running on
-- an already-migrated DB is a safe no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'service_build' AND column_name = 'framework'
  ) THEN
    UPDATE "service_build" SET "runtime_version" = ''
    WHERE "framework" IN ('python', 'go', 'rust', 'php');
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "services" DROP COLUMN IF EXISTS "framework";--> statement-breakpoint
ALTER TABLE "service_build" DROP COLUMN IF EXISTS "framework";--> statement-breakpoint
ALTER TABLE "service_build_method_settings" DROP COLUMN IF EXISTS "heroku_version";
