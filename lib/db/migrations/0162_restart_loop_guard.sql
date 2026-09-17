ALTER TABLE "apps" ADD COLUMN "restart_loop_guard" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "restart_loop_stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "restart_loop_guard" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "databases" ADD COLUMN "restart_loop_stopped_at" timestamp with time zone;
