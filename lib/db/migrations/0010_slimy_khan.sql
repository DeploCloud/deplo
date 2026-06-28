CREATE TABLE "registration_link_team_capabilities" (
	"link_team_id" text NOT NULL,
	"capability" text NOT NULL,
	CONSTRAINT "registration_link_team_capabilities_link_team_id_capability_pk" PRIMARY KEY("link_team_id","capability")
);
--> statement-breakpoint
CREATE TABLE "registration_link_teams" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"team_id" text NOT NULL,
	"role" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "registration_links" ADD COLUMN "mode" text DEFAULT 'own_team' NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_link_team_capabilities" ADD CONSTRAINT "registration_link_team_capabilities_link_team_id_registration_link_teams_id_fk" FOREIGN KEY ("link_team_id") REFERENCES "public"."registration_link_teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_link_teams" ADD CONSTRAINT "registration_link_teams_link_id_registration_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."registration_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_link_teams" ADD CONSTRAINT "registration_link_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_link_teams_link_team_uq" ON "registration_link_teams" USING btree ("link_id","team_id");--> statement-breakpoint
CREATE INDEX "registration_link_teams_link_idx" ON "registration_link_teams" USING btree ("link_id");