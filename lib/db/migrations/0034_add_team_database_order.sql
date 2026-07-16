-- Team-wide database display order for the Storage grid — the direct analogue of
-- team_app_order for databases. Lets a team drag-reorder its database cards and
-- have the arrangement persist for every member (like the Overview apps grid).
--
-- PK (team_id, database_id); both FKs ON DELETE CASCADE so a deleted database or
-- team can't leave a dead id in the order — the self-healing is a DB invariant,
-- not application logic. Purely additive; a database not listed here falls back
-- to newest-first, so existing teams need no backfill.
CREATE TABLE "team_database_order" (
	"team_id" text NOT NULL,
	"database_id" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "team_database_order_team_id_database_id_pk" PRIMARY KEY("team_id","database_id")
);
--> statement-breakpoint
ALTER TABLE "team_database_order" ADD CONSTRAINT "team_database_order_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_database_order" ADD CONSTRAINT "team_database_order_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;
