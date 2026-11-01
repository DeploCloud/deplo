-- Automatic DNS: DNS provider accounts people connect, the teams they serve, and the records and tunnels Deplo made with them.
CREATE TABLE "dns_provider_teams" (
	"provider_id" text NOT NULL,
	"team_id" text NOT NULL,
	CONSTRAINT "dns_provider_teams_provider_id_team_id_pk" PRIMARY KEY("provider_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "dns_provider_tunnels" (
	"id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"server_id" text NOT NULL,
	"tunnel_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"zone_name" text NOT NULL,
	"zone_id" text NOT NULL,
	"account_id" text NOT NULL,
	"api_token_enc" text NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_dns_records" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"record_id" text NOT NULL,
	"tunnel_id" text,
	"created" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "tunnel" boolean;--> statement-breakpoint
ALTER TABLE "dns_provider_teams" ADD CONSTRAINT "dns_provider_teams_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_teams" ADD CONSTRAINT "dns_provider_teams_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_tunnels" ADD CONSTRAINT "dns_provider_tunnels_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_provider_tunnels" ADD CONSTRAINT "dns_provider_tunnels_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_providers" ADD CONSTRAINT "dns_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_dns_records" ADD CONSTRAINT "domain_dns_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_dns_records" ADD CONSTRAINT "domain_dns_records_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_dns_records" ADD CONSTRAINT "domain_dns_records_tunnel_id_dns_provider_tunnels_id_fk" FOREIGN KEY ("tunnel_id") REFERENCES "public"."dns_provider_tunnels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_provider_teams_team_idx" ON "dns_provider_teams" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dns_provider_tunnels_provider_server_uq" ON "dns_provider_tunnels" USING btree ("provider_id","server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dns_providers_user_zone_uq" ON "dns_providers" USING btree ("user_id","zone_name");--> statement-breakpoint
CREATE INDEX "dns_providers_zone_idx" ON "dns_providers" USING btree ("zone_name");--> statement-breakpoint
CREATE INDEX "domain_dns_records_provider_idx" ON "domain_dns_records" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "domain_dns_records_tunnel_idx" ON "domain_dns_records" USING btree ("tunnel_id");