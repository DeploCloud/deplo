-- Every server links in (ADR-0040), so no agent port is dialed. The certificate pin alone marks an
-- enrolled server now: a row that had a port keeps an agent (an empty pin is trust withdrawn).
UPDATE "servers" SET "agent_cert_fingerprint" = '' WHERE "agent_port" IS NOT NULL AND "agent_cert_fingerprint" IS NULL;
--> statement-breakpoint
UPDATE "servers" SET "agent_cert_fingerprint" = NULL WHERE "agent_port" IS NULL AND "agent_cert_fingerprint" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN IF EXISTS "agent_port";
