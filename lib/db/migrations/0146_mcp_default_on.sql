-- A new team starts with MCP on again, reverting 0106. The token is still the
-- gate; the switch stays one click away on the MCP screen for a team that wants
-- it shut. The DEFAULT moves, no row is touched.

ALTER TABLE "teams" ALTER COLUMN "mcp_enabled" SET DEFAULT true;
