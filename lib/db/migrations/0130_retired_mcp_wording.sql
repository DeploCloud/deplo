-- 0128 caught `Revoked <client>'s MCP access`, the wording the code writes today.
-- An older build wrote `Removed <client>'s MCP access to this team` for the same
-- event, so those rows stayed under `member` - an MCP revoke filed under People,
-- which is the exact thing the split was for.
UPDATE "activities" SET "type" = 'mcp'
 WHERE "type" = 'member'
   AND "message" LIKE 'Removed %''s MCP access to this team';
