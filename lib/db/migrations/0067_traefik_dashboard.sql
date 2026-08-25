-- The Traefik web panel, per server. Deplo installs a Traefik on every host it
-- can (install-agent.sh); this is the opt-in that publishes that Traefik's own
-- dashboard on a domain.
--
-- Credentials are NOT optional: the dashboard exposes every router, service and
-- certificate on the host, so a domain without a username and password would be
-- a one-click way to publish the fleet's routing table. The data layer refuses
-- to set a domain without both - these columns move together or not at all.
--
-- The password is stored the same way every other secret is (AES-256-GCM via
-- DEPLO_SECRET) because the htpasswd line has to be re-derived whenever the
-- stack file is rewritten - changing the domain must not mean retyping the
-- password. It is never projected into a DTO and has no reveal path.
ALTER TABLE "servers"
  ADD COLUMN IF NOT EXISTS "traefik_dashboard_domain" text,
  ADD COLUMN IF NOT EXISTS "traefik_dashboard_user" text,
  ADD COLUMN IF NOT EXISTS "traefik_dashboard_password_enc" text;
