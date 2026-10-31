-- Nothing dials a server any more (ADR-0040, ADR-0041): the certificate pin alone marks an enrolled
-- server. Expand only: agent_port stays, read by 0.6.0 if the installer rolls an update back.
UPDATE "servers" SET "agent_cert_fingerprint" = '' WHERE "agent_port" IS NOT NULL AND "agent_cert_fingerprint" IS NULL;
--> statement-breakpoint
UPDATE "servers" SET "agent_cert_fingerprint" = NULL WHERE "agent_port" IS NULL AND "agent_cert_fingerprint" IS NOT NULL;
