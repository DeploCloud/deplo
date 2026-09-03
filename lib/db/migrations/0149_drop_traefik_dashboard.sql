-- The Traefik web panel is gone: nothing publishes the host's own dashboard.
ALTER TABLE "servers"
  DROP COLUMN IF EXISTS "traefik_dashboard_domain",
  DROP COLUMN IF EXISTS "traefik_dashboard_user",
  DROP COLUMN IF EXISTS "traefik_dashboard_password_enc";
