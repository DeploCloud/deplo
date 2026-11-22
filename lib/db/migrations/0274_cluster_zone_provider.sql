ALTER TABLE "cluster_dns_zones" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "domain_dns_records" ADD COLUMN "acme_record_id" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cluster_fallback" text;--> statement-breakpoint
ALTER TABLE "cluster_dns_zones" ADD CONSTRAINT "cluster_dns_zones_provider_id_dns_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."dns_providers"("id") ON DELETE set null ON UPDATE no action;