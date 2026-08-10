-- Retention is a QUANTITY now ("keep the last N backups"), not a window in days.
--
-- "How many do I keep?" is the question people actually ask, and it is the only
-- one that answers itself at any cadence: 7 days of an hourly schedule is 168
-- artifacts, which nobody asked for and no bucket bill expects.
--
-- The number carries over as-is: a 14-day daily schedule becomes "keep the last
-- 14", which is the same history it had. A sub-daily schedule keeps fewer
-- artifacts than before - that is the point of the change, not a side effect of
-- it. The clamp matches the one the data layer applies on every write.

ALTER TABLE "backups" RENAME COLUMN "retention_days" TO "retention_count";
--> statement-breakpoint

UPDATE "backups" SET "retention_count" = LEAST(GREATEST("retention_count", 1), 365);
