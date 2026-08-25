-- A new team decides for itself whether AI agents may drive it.
--
-- `teams.mcp_enabled` shipped defaulting to TRUE, on the reasoning that an API
-- token is required anyway and the switch is a policy lever rather than the
-- thing that makes `/api/mcp` safe. Both halves are still true; what was wrong
-- is the direction. "May an AI agent act in this company's infrastructure" is a
-- decision an operator should make, and a kill switch that ships already open
-- is one nobody knows they have until they go looking for it.
--
-- The DEFAULT moves; no row is touched. Every existing team keeps exactly the
-- value it has, so nothing that works today stops working - this only changes
-- what a team created from now on starts with, and turning it on is one switch
-- on the screen that explains what it does.

ALTER TABLE "teams" ALTER COLUMN "mcp_enabled" SET DEFAULT false;
