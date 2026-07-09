-- Git deploy options, flattened onto `services` alongside the other repo_* fields:
--   - repo_trigger_type  which git event auto-deploys — "push" (to repo_branch) or
--                        "tag" (any new tag). NULL ⇒ "push" (historical behaviour).
--   - repo_watch_paths   newline-separated path globs; an auto-deploy only fires
--                        when a pushed commit touched a matching file. NULL ⇒ any.
--   - repo_submodules    clone the repo's git submodules at build time.
-- Purely additive: existing services get NULL / false (no behaviour change).
ALTER TABLE "services" ADD COLUMN "repo_trigger_type" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "repo_watch_paths" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "repo_submodules" boolean DEFAULT false NOT NULL;
