-- The MCP server's two team switches (`/api/mcp`, protocol revision 2026-07-28).
-- See docs/adr/0021-the-mcp-server-is-a-first-party-route-not-a-plugin.md.
--
-- Deliberately JUST the columns: the `manage_mcp` backfill is 0099, because a
-- backfill reads tables that a historical replay may not have created yet, while
-- an additive column on `teams` is safe to apply at any point (the 0085 case -
-- see the pre-seed lists in lib/db/*-migration.test.ts, which this file joins).
--
-- Both DEFAULT true, so every existing team is AI-ready the moment it upgrades:
-- a token is required to reach the endpoint at all, so an off-by-default switch
-- would only mean "copy the connect line, get a 403, go hunting for a toggle".
--
-- `mcp_confirm_destructive` defaults true for the opposite reason: the first time
-- an agent decides to delete something should be a question in the operator's MCP
-- client, not a fact discovered afterwards. Turning it off is one click for a team
-- that wants its agent unattended.
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "mcp_enabled" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN IF NOT EXISTS "mcp_confirm_destructive" boolean NOT NULL DEFAULT true;
