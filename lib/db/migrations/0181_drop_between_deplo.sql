-- The deplo-to-deplo migration is shelved on a branch; its tables and columns go with it.
DROP TABLE IF EXISTS "deplo_move_pauses" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "deplo_move_servers" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "deplo_move_workloads" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "deplo_moves" CASCADE;--> statement-breakpoint
ALTER TABLE "backup_runs" DROP COLUMN IF EXISTS "copied_from";--> statement-breakpoint
ALTER TABLE "migration_runs" DROP COLUMN IF EXISTS "live_copy";
