-- Canary releases are one instance switch for Deplo and every agent; a per-server choice broke mixed fleets.
ALTER TABLE "servers" DROP COLUMN IF EXISTS "agent_canary";
