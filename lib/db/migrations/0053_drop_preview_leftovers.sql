-- Pull request previews are withdrawn — the schema goes with the feature.
--
-- An earlier 0053 ("add_app_previews") created a per-pull-request preview stack:
-- `app_previews`, the preview-only variable overrides in `app_preview_env_vars`,
-- four `preview_*` settings on `apps`, and `deploy_key` / `pr_number` /
-- `preview_id` on `deployments`. That migration is gone from the journal, so an
-- instance created from here never sees any of it.
--
-- This one exists for the instances that DID apply it before the feature was
-- removed: without it they keep an orphan `deployments.deploy_key` that is NOT
-- NULL with no default, and the very next deploy insert — which no longer writes
-- that column — fails. Hence it is IF EXISTS throughout: a real cleanup where the
-- old 0053 ran, a no-op everywhere else.

DROP TABLE IF EXISTS "app_preview_env_vars";
--> statement-breakpoint
-- Before `app_previews`, because this column FKs into it. Dropping it also drops
-- the partial index that was built on it.
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "preview_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "app_previews";
--> statement-breakpoint
-- The deploy key is back to being derived (`apps.slug`), never stored.
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "deploy_key";
--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "pr_number";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "preview_enabled";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "preview_base_domain";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "preview_max_active";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "preview_ttl_days";
--> statement-breakpoint
ALTER TABLE "apps" DROP COLUMN IF EXISTS "preview_fork_policy";
