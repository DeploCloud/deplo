-- The address this Deplo answers on, editable from Settings → Deplo.
--
-- It exists because the same fact used to live in ONE place only: the
-- DEPLO_PUBLIC_URL environment variable, set once by install.sh and changeable
-- only by editing a file on the host and recreating the container, i.e. by SSH,
-- which is exactly what Deplo exists not to require. Every copy-and-run string
-- Deplo hands out is built from it (a server's install command, a deploy hook
-- URL, an invite link), so an instance that moved to a real domain kept handing
-- out the old one.
--
-- NULL means "not configured here": the resolver falls back to DEPLO_PUBLIC_URL
-- and then to the request's own host, so an instance that never opens this page
-- behaves exactly as it did before.
ALTER TABLE "instance_settings"
  ADD COLUMN IF NOT EXISTS "panel_url" text;
