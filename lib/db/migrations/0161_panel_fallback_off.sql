-- The panel's generated `deplo-<hex>.nip.io` backup route, turned off.
--
-- It was unconditional, and re-seeded on every address or scheme change, so the
-- only place the operator's choice can live is here: with the flag set, the two
-- re-seed sites leave the router out instead of putting it back.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "panel_fallback_disabled" boolean DEFAULT false NOT NULL;
