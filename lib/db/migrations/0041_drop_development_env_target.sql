-- Companion to 0039 (dev mode removed): retire the `development` env-target.
--
-- The target axis (production | preview | development) gated which runtime an
-- env var reached. Its `development` value had exactly ONE runtime consumer —
-- the dev container's env resolution — which 0039's feature removal deleted, so
-- development-targeted rows are now write-only dead data no code path can ever
-- select. The axis narrows to `production | preview` (matching
-- DeploymentEnvironment); EnvTarget/EnvTargetEnum shrink in the same change.
--
-- ORDER MATTERS. The resolver treats an EMPTY target set as "every runtime"
-- (sanitizeTargets falls back to all, and the shared-var loader defaults an
-- empty set the same way). So a var that targeted ONLY `development` must NOT
-- simply lose its junction rows — that would silently WIDEN a dev-only secret
-- into production/preview. Delete those parents FIRST (their junction/scope
-- rows cascade), and only then strip the remaining `development` rows from
-- mixed-target vars. At removal time the live instance had zero dev-only vars
-- in all three stores, so the parent deletes are formally-correct no-ops there.
--
-- Hand-authored (snapshots stop at 0014; drizzle-kit generate cannot diff).
DELETE FROM "env_vars" v
 WHERE EXISTS (SELECT 1 FROM "env_var_targets" t WHERE t."env_var_id" = v."id")
   AND NOT EXISTS (SELECT 1 FROM "env_var_targets" t
                    WHERE t."env_var_id" = v."id" AND t."target" <> 'development');--> statement-breakpoint
DELETE FROM "instance_env_vars" v
 WHERE EXISTS (SELECT 1 FROM "instance_env_var_targets" t WHERE t."env_var_id" = v."id")
   AND NOT EXISTS (SELECT 1 FROM "instance_env_var_targets" t
                    WHERE t."env_var_id" = v."id" AND t."target" <> 'development');--> statement-breakpoint
DELETE FROM "shared_env_vars" v
 WHERE EXISTS (SELECT 1 FROM "shared_env_var_targets" t WHERE t."var_id" = v."id")
   AND NOT EXISTS (SELECT 1 FROM "shared_env_var_targets" t
                    WHERE t."var_id" = v."id" AND t."target" <> 'development');--> statement-breakpoint
DELETE FROM "env_var_targets" WHERE "target" = 'development';--> statement-breakpoint
DELETE FROM "instance_env_var_targets" WHERE "target" = 'development';--> statement-breakpoint
DELETE FROM "shared_env_var_targets" WHERE "target" = 'development';
