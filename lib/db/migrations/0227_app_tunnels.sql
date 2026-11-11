-- A cluster App's own Cloudflare Tunnel, and which of its domains the tunnel serves (spec #176, ADR-0042); the run token is encrypted.
CREATE TABLE IF NOT EXISTS "app_tunnels" (
	"app_id" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"tunnel_id" text NOT NULL,
	"token_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_tunnel_domains" (
	"domain_id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"was_tunnel" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_tunnels" ADD CONSTRAINT "app_tunnels_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_tunnels" ADD CONSTRAINT "app_tunnels_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_tunnel_domains" ADD CONSTRAINT "app_tunnel_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_tunnel_domains" ADD CONSTRAINT "app_tunnel_domains_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "app_tunnel_domains" ADD CONSTRAINT "app_tunnel_domains_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_tunnel_domains_app_idx" ON "app_tunnel_domains" USING btree ("app_id");
