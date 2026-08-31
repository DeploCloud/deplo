-- Host ports an app publishes. Deplo routed every app through its proxy, so a
-- game server, an SMTP relay or a database an app exposes had no way across from
-- another platform except being rewritten as a compose stack by hand.
CREATE TABLE IF NOT EXISTS "app_ports" (
  "app_id" text NOT NULL REFERENCES "apps"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "port_id" text NOT NULL,
  "published" integer NOT NULL,
  "target" integer NOT NULL,
  "protocol" text DEFAULT 'tcp' NOT NULL,
  CONSTRAINT "app_ports_pkey" PRIMARY KEY ("app_id","position")
);
