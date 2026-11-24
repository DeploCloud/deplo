-- Tunnels in use while they sat outside the experiments keep working.
UPDATE "instance_settings" SET "experiment_tunnels" = true WHERE "panel_tunnel_hostname" IS NOT NULL OR EXISTS (SELECT 1 FROM "domains" WHERE "tunnel" = true);
