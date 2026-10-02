-- ADR-0035: moving a whole Deplo to another machine. Local to each machine, never copied.
CREATE TABLE IF NOT EXISTS "deplo_moves" (
	"id" text PRIMARY KEY NOT NULL,
	"side" text NOT NULL,
	"state" text NOT NULL,
	"code_hash" text,
	"code_enc" text,
	"expires_at" timestamp with time zone,
	"peer_url" text,
	"peer_instance" text,
	"started_by" text NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"rows_copied" integer DEFAULT 0 NOT NULL,
	"unreadable" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deplo_moves_side_state_idx" ON "deplo_moves" USING btree ("side","state");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deplo_move_servers" (
	"move_id" text NOT NULL,
	"server_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deplo_move_servers_move_id_server_id_pk" PRIMARY KEY("move_id","server_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deplo_move_servers" ADD CONSTRAINT "deplo_move_servers_move_id_deplo_moves_id_fk" FOREIGN KEY ("move_id") REFERENCES "public"."deplo_moves"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
