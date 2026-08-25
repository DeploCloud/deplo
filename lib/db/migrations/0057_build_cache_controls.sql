-- Build cache controls, per app, plus an honest "Rebuild container".
--
-- `app_build.build_cache` - reuse the owning server's Docker layer cache between
-- this app's builds. ON for every existing app, because that is what they have
-- been doing and it is what makes a redeploy of an unchanged app take seconds.
-- OFF means every build runs `docker build --no-cache` and nixpacks is left on
-- its per-build-dir cache key, so no layer and no cache mount is carried over.
--
-- `app_build.build_cache_clear_pending` - armed by the "Clear build cache"
-- button, consumed by the next build. There is nothing to delete on the host: the
-- BuildKit cache is per-SERVER and shared by every app on it, so pruning it from
-- one app's settings would silently slow down its neighbours (and, on a managed
-- deplo, another tenant). An app therefore clears its own cache the only way it
-- owns: the next build refuses to read it and rewrites what it replaces.
--
-- `deployments.force_recreate` - this deploy replaces the running containers even
-- when the rendered stack is byte-identical. Only "Rebuild container" sets it:
-- `docker compose up -d` compares compose's own config hash and does NOTHING when
-- it matches, so for a compose stack or a prebuilt image whose config had not
-- moved, Rebuild reported a green deployment while the old container kept running.
ALTER TABLE "app_build" ADD COLUMN IF NOT EXISTS "build_cache" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "app_build" ADD COLUMN IF NOT EXISTS "build_cache_clear_pending" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "force_recreate" boolean DEFAULT false NOT NULL;
