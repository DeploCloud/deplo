-- Deleting an app is a STATE, not a request.
--
-- The delete tears down a stack on the host: previews first, then `compose down
-- -v`, then the uploads. Seconds on a healthy box, up to the gRPC dial timeout
-- on an unreachable one - and for all of it the dialog held the user in front of
-- a spinner over a decision they had already made and cannot undo. Worse, a
-- reload during that window served the app back as a perfectly live card they
-- could click into, deploy, or delete a second time.
--
-- The stamp is what the whole flow hangs off: it is written BEFORE the teardown,
-- so from the moment the user confirms, every gate refuses the app, its pages
-- 404, and the Overview shows it as a dimmed, pulsing card that survives a
-- reload. The row itself goes when the teardown finishes.
--
-- It also makes the operation crash-safe, which it was not: a control plane that
-- dies mid-teardown leaves the stamp behind, and the boot reconcile
-- (`resumeAppDeletes`) finishes what the dead process started instead of leaving
-- an app half-torn-down and fully clickable.

ALTER TABLE "apps" ADD COLUMN IF NOT EXISTS "deleting_at" timestamptz;
