-- Dev mode is removed from the product: the live, editable dev container with
-- hot reload and SSH access that ran alongside the production stack, plus the
-- SSH gateway that fanned dev SSH users into it and the VS Code tunnel. The
-- whole feature (UI, GraphQL surface, data layer, deploy paths, gateway
-- rendering) is gone from the control plane, so its storage goes too:
--
--  * `app_dev` — the per-app dev config (1-to-1 child of apps). At removal
--    time the fleet held a single row (disabled, status 'off'); its host-side
--    remnant (container/workspace/deps volume) was torn down via the agent's
--    TeardownDev RPC before this migration shipped.
--  * `dev_ssh_user` — SSH gateway accounts. Empty on every real instance (the
--    gateway was lazy-created on the first user, so no gateway container was
--    ever provisioned fleet-wide).
--  * TYPE `dev_status` — used only by `app_dev.status`, dropped after it.
--  * `deployments.build_source` — the "deploy from dev workspace" provenance
--    marker; 'dev-workspace' was its only ever value, and no live row carries
--    one.
--
-- The agent's dev/gateway/tunnel RPCs stay in the Go binary (the V1 contract is
-- additive-only, fleet releases are forward-only); the control plane simply
-- never calls them again. The host-side uninstaller keeps its legacy
-- `deplo-ssh-gateway` sweep for hosts provisioned before the removal.
--
-- Both tables are FK leaves (they only point OUT to `apps`), so no CASCADE and
-- no ordering constraints beyond enum-after-table.
--
-- Hand-authored: the committed drizzle snapshots stop at 0014, so
-- `drizzle-kit generate` cannot diff against an up-to-date base. The SQL +
-- journal entry are what the boot migrator (lib/db/migrate.ts) and the pglite
-- tests actually replay, matching every migration since 0015.
DROP TABLE IF EXISTS "app_dev";--> statement-breakpoint
DROP TABLE IF EXISTS "dev_ssh_user";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."dev_status";--> statement-breakpoint
ALTER TABLE "deployments" DROP COLUMN IF EXISTS "build_source";
