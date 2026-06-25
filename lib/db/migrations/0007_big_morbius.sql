CREATE TABLE "server_teams" (
	"server_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "server_teams_server_id_team_id_pk" PRIMARY KEY("server_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "all_teams" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "server_teams" ADD CONSTRAINT "server_teams_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_teams" ADD CONSTRAINT "server_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;