-- Nothing has written these since the telemetry stream replaced the polling
-- collector: they read 0 on every server, and the Monitoring card served that 0
-- as a live snapshot. The live numbers come off the stream's ring buffer.
ALTER TABLE "servers" DROP COLUMN IF EXISTS "cpu_usage";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN IF EXISTS "memory_usage";--> statement-breakpoint
ALTER TABLE "servers" DROP COLUMN IF EXISTS "disk_usage";
