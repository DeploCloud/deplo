-- Which agent an MCP token connects, so the dashboard can show its own mark.
ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "mcp_agent" text;
