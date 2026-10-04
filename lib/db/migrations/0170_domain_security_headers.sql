-- New domains send the security headers; a domain that existed before keeps answering as it did.
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "security_headers" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "domains" ALTER COLUMN "security_headers" SET DEFAULT true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_cors_origins" (
	"domain_id" text NOT NULL,
	"position" integer NOT NULL,
	"origin" text NOT NULL,
	CONSTRAINT "domain_cors_origins_domain_id_position_pk" PRIMARY KEY("domain_id","position")
);
--> statement-breakpoint
ALTER TABLE "domain_cors_origins" ADD CONSTRAINT "domain_cors_origins_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;
