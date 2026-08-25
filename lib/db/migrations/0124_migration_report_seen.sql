-- The wizard opens on the run somebody left, not on an empty form.
--
-- A migration runs in the control plane, so leaving the page costs nothing - but
-- coming back gave a blank connect form: every screen the wizard showed lived in
-- the tab that started the run, and the tab was gone. This is the one bit of
-- state that could not be derived: whether the person is done LOOKING at the run.
--
-- NULL means the wizard still opens on it (in progress, or finished and unread);
-- stamped means they closed the report, undid the migration, or kept what landed.
ALTER TABLE "dokploy_imports" ADD COLUMN IF NOT EXISTS "report_seen_at" timestamptz;
