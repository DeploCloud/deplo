ALTER TABLE "deplo_state" ALTER COLUMN "updated_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deplo_state" ALTER COLUMN "updated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduler_lease" ALTER COLUMN "heartbeat_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduler_lease" ALTER COLUMN "heartbeat_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "scheduler_lease" ALTER COLUMN "acquired_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduler_lease" ALTER COLUMN "acquired_at" SET DEFAULT now();