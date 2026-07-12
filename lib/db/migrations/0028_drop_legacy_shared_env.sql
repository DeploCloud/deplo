-- ADR-0010: drop the three legacy shared-variable systems now that 0027 converted
-- their rows into unified `shared_env_vars`. Split from 0027 so a migration-parity
-- test can replay to 0027 (old tables present) and assert resolution is preserved.
-- Instance-global vars (`instance_env_vars`/`_targets`) are deliberately UNTOUCHED
-- — they remain a separate admin-only, cross-team system.

DROP TABLE "shared_env_group_targets";--> statement-breakpoint
DROP TABLE "shared_env_group_apps";--> statement-breakpoint
DROP TABLE "shared_env_group_vars";--> statement-breakpoint
DROP TABLE "shared_env_groups";--> statement-breakpoint
DROP TABLE "environment_env_vars";--> statement-breakpoint
DROP TABLE "team_global_env_var_targets";--> statement-breakpoint
DROP TABLE "team_global_env_vars";
