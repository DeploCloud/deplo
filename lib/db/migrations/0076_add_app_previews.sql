-- Preview deployments: one ephemeral stack per open pull request.
--
-- A Preview is NOT an App and NOT an Environment. It is a (App, pull request)
-- pair that owns its own Docker stack, rendered from the App's build config but
-- keyed on `<app slug>__pr-<n>` - the deploy-key scheme ADR-0008 spec'd and
-- lib/deploy/deploy-key.ts has carried unused since. Because a slug is [a-z0-9-]
-- and can never contain `__`, `deplo-<slug>__pr-42` can never byte-collide with
-- another app's bare `deplo-<otherslug>`.
--
-- WHY A `deploy_key` COLUMN ON `deployments`
-- Everything a deploy touches on the host is keyed on a slug-shaped string: the
-- container `deplo-<key>`, the stack file `<key>.yml`, the files dir
-- `files/<key>`, the named volumes `deplo-<key>-<name>`, and every agent RPC.
-- Until now that string WAS `apps.slug`, so a preview would have overwritten the
-- production stack. The key is denormalized onto the deployment row for the same
-- reason `server_id` already is: it records what was ACTUALLY deployed, it is
-- read by the queue drain and by `runDeployment`'s single-row load without an
-- apps join, and it outlives the preview row - a deploy still in flight when its
-- preview is destroyed must still be able to name the stack it touched.
-- Existing rows backfill to the app slug, which is exactly what they deployed, so
-- every production stack, volume and certificate stays byte-identical.
--
-- `pr_number` is likewise denormalized onto `deployments` so the deployments list
-- can still say "PR #42" long after the preview row is reaped.

ALTER TABLE "deployments" ADD COLUMN "deploy_key" text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE "deployments" d SET "deploy_key" = a."slug" FROM "apps" a WHERE a."id" = d."app_id";
--> statement-breakpoint
-- Drop the default so a future write path that forgets the key fails loudly
-- instead of silently deploying to the container named `deplo-`.
ALTER TABLE "deployments" ALTER COLUMN "deploy_key" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "pr_number" integer;
--> statement-breakpoint
-- The preview this deploy belongs to, or NULL for a production deploy. The FK is
-- added below (after `app_previews` exists) and is SET NULL, so reaping a preview
-- never deletes the build history of what it deployed.
ALTER TABLE "deployments" ADD COLUMN "preview_id" text;
--> statement-breakpoint
-- One row per (App, pull request).
--
-- TWO STATE COLUMNS, ON PURPOSE:
--   `state`  is the LIFECYCLE  - open | closed. Set by the pull request itself.
--   `status` is the RUNTIME    - blocked | queued | building | active | error |
--                                idle. It mirrors what `apps.status` means for an
--                                App, and it exists so a preview build can never
--                                repaint the production app's badge.
--
-- The row SURVIVES the PR close (`state = 'closed'`). That is what makes teardown
-- idempotent AND retryable: `torn_down_at IS NULL` is the reaper's retry
-- predicate, and stamping it is the only proof the stack is really gone. Deleting
-- the row on close instead would mean an agent that was unreachable at that exact
-- moment leaks a container and a volume set that nothing points at any more.
--
-- `deploy_key` and `host` are minted ONCE at PR-open and never recomputed - the
-- URL gets commented on the pull request, so a resync that regenerated either
-- would strand the link somebody is testing.
--
-- FORK SAFETY: a pull request from a fork is attacker-authored code that would
-- run with this App's decrypted secrets on the operator's host. `is_fork` lands
-- it `status = 'blocked'` until a member with `deploy` approves it, and the
-- approval is bound to `approved_sha` - a later push clears it, because
-- approve-once is exactly the TOCTOU hole `pull_request_target` taught everyone.
CREATE TABLE "app_previews" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "pr_number" integer NOT NULL,
  "pr_title" text DEFAULT '' NOT NULL,
  "pr_author" text DEFAULT '' NOT NULL,
  "pr_url" text DEFAULT '' NOT NULL,
  "head_branch" text NOT NULL,
  "head_sha" text DEFAULT '' NOT NULL,
  "head_repo" text DEFAULT '' NOT NULL,
  "head_clone_url" text DEFAULT '' NOT NULL,
  "base_branch" text DEFAULT '' NOT NULL,
  "is_fork" boolean DEFAULT false NOT NULL,
  "approved_by_user_id" text,
  "approved_at" timestamp with time zone,
  "approved_sha" text,
  "deploy_key" text NOT NULL,
  "host" text NOT NULL,
  "cert_provider" text DEFAULT 'none' NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "latest_deployment_id" text,
  "url" text DEFAULT '' NOT NULL,
  "comment_id" bigint,
  "state" text DEFAULT 'open' NOT NULL,
  "closed_at" timestamp with time zone,
  "torn_down_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Preview-only environment variable OVERRIDES (advanced). A preview inherits the
-- App's variables verbatim by default - the Vercel behaviour, and the one that
-- needs no configuration. This table is the escape hatch for the one case that
-- genuinely matters: pointing a preview at a scratch database instead of the
-- production one.
--
-- A separate table rather than a second `env_vars` row because
-- `env_vars_app_key_uq` is UNIQUE(app_id, key) - two values for one key are not
-- representable there. It folds LAST in lib/deploy/env-resolve.ts (above the
-- app's own vars AND above linked shared vars) and only for the `preview` target:
-- an override is the most specific statement a user can make, and if a team-wide
-- shared variable outranked it the feature could not do the one thing it exists
-- for.
CREATE TABLE "app_preview_env_vars" (
  "id" text PRIMARY KEY NOT NULL,
  "app_id" text NOT NULL,
  "key" text NOT NULL,
  "value_enc" text NOT NULL,
  "type" text DEFAULT 'plain' NOT NULL,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Per-app preview settings, flattened onto `apps` exactly like `resource_*`:
-- NULL means "use the platform default", so an app that never opened the setting
-- renders identically to one that did.
--
-- `preview_enabled` is OFF by default: previews are containers on someone's VPS,
-- and turning them on for every existing GitHub app without being asked is not a
-- default anyone chose.
ALTER TABLE "apps" ADD COLUMN "preview_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- NULL ⇒ a deterministic nip.io host on plain HTTP (zero DNS configuration, and
-- nip.io can never hold a Let's Encrypt certificate - it is ONE registered domain
-- sharing one rate limit across the whole internet). A base like
-- `preview.example.com` needs ONE wildcard DNS record and gives each preview its
-- own HTTP-01 certificate from the existing letsencrypt resolver.
ALTER TABLE "apps" ADD COLUMN "preview_base_domain" text;
--> statement-breakpoint
-- NULL ⇒ PREVIEW_MAX_ACTIVE_DEFAULT. "Keep at most N", meant literally: at the
-- cap a NEW preview EVICTS the open one with the oldest `last_activity_at`.
-- The evicted row survives (`status = 'evicted'`, `state` still `open`) and is
-- NOT revived by the next push - only by a person clicking Redeploy. Without
-- that asymmetry, three active pull requests under a cap of three would tear
-- each other down on every commit, a full build per cycle.
ALTER TABLE "apps" ADD COLUMN "preview_max_active" integer;
--> statement-breakpoint
-- NULL ⇒ PREVIEW_TTL_DAYS_DEFAULT. Idle-days before the reaper closes a preview.
-- It is what makes the cap SELF-HEALING (without it, three abandoned pull
-- requests would hold an app's slots forever) and it is the safety net for a
-- `closed` webhook that never arrived. Any sync bumps `last_activity_at`, so an
-- active pull request never expires.
ALTER TABLE "apps" ADD COLUMN "preview_ttl_days" integer;
--> statement-breakpoint
-- NULL ⇒ 'approve'. deny | approve | allow.
--   approve - a fork's pull request appears in the list as blocked and waits for
--             a member with `deploy`. Nothing is cloned, built or run before that.
--   deny    - fork pull requests are ignored entirely.
--   allow   - expert mode: build them like any other. Even then a fork preview
--             gets no `secret`-typed variables.
ALTER TABLE "apps" ADD COLUMN "preview_fork_policy" text;
--> statement-breakpoint
-- Where previews run. NULL ⇒ the app's own `server_id`, which is the honest
-- default: a preview is only worth trusting if it runs where production runs.
-- The override exists because deplo is multi-server and the competitors are not -
-- pointing pull request builds at a scrap machine keeps them off the box that
-- serves production. SET NULL so retiring that server quietly returns later
-- previews to the app's own server rather than failing to deploy.
ALTER TABLE "apps" ADD COLUMN "preview_server_id" text;
--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_preview_server_id_servers_id_fk"
  FOREIGN KEY ("preview_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_previews" ADD CONSTRAINT "app_previews_app_id_apps_id_fk"
  FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_previews" ADD CONSTRAINT "app_previews_latest_deployment_id_deployments_id_fk"
  FOREIGN KEY ("latest_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_previews" ADD CONSTRAINT "app_previews_approved_by_user_id_users_id_fk"
  FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_preview_env_vars" ADD CONSTRAINT "app_preview_env_vars_app_id_apps_id_fk"
  FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_preview_env_vars" ADD CONSTRAINT "app_preview_env_vars_created_by_user_id_users_id_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "app_preview_env_vars" ADD CONSTRAINT "app_preview_env_vars_updated_by_user_id_users_id_fk"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- SET NULL, not CASCADE: reaping a preview must never delete the build history of
-- what it deployed.
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_preview_id_app_previews_id_fk"
  FOREIGN KEY ("preview_id") REFERENCES "public"."app_previews"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- One preview per (app, pull request); one stack per deploy key and one router
-- per host, instance-wide.
CREATE UNIQUE INDEX "app_previews_app_pr_uq" ON "app_previews" USING btree ("app_id","pr_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_previews_deploy_key_uq" ON "app_previews" USING btree ("deploy_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "app_previews_host_uq" ON "app_previews" USING btree ("host");
--> statement-breakpoint
CREATE INDEX "app_previews_app_idx" ON "app_previews" USING btree ("app_id");
--> statement-breakpoint
-- The reaper's two scans: open previews by idleness, and closed-but-not-yet-torn-
-- down previews to retry. Partial, so each indexes only its own live working set.
CREATE INDEX "app_previews_open_idx" ON "app_previews" USING btree ("last_activity_at") WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX "app_previews_untorn_idx" ON "app_previews" USING btree ("closed_at") WHERE "torn_down_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "app_preview_env_vars_app_key_uq" ON "app_preview_env_vars" USING btree ("app_id","key");
--> statement-breakpoint
CREATE INDEX "deployments_preview_idx" ON "deployments" USING btree ("preview_id","created_at" DESC,"seq" DESC);
