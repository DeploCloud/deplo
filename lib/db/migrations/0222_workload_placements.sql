-- The leader's placement of a cluster workload, mirrored (spec #176). A null member is waiting for room.
CREATE TABLE IF NOT EXISTS "workload_placements" (
	"kind" text NOT NULL,
	"workload_id" text NOT NULL,
	"replica" integer DEFAULT 0 NOT NULL,
	"member_server_id" text,
	"epoch" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workload_placements_kind_workload_id_replica_pk" PRIMARY KEY("kind","workload_id","replica")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workload_placements" ADD CONSTRAINT "workload_placements_member_server_id_servers_id_fk" FOREIGN KEY ("member_server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workload_placements_member_idx" ON "workload_placements" USING btree ("member_server_id");
