-- ADR-0008 Phase 3b: per-(Service, Environment) runtime-state join. Additive and
-- inert until the deploy pipeline is environment-parameterized (a later step) —
-- a row is created when a service is first deployed to an environment. The stack
-- deploy KEY is derived (env-deploy-key.ts), not stored.

CREATE TABLE "service_environments" (
	"service_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"url" text,
	"latest_deployment_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "service_environments_service_id_environment_id_pk" PRIMARY KEY("service_id","environment_id")
);
--> statement-breakpoint
ALTER TABLE "service_environments" ADD CONSTRAINT "service_environments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_environments" ADD CONSTRAINT "service_environments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_environments" ADD CONSTRAINT "service_environments_latest_deployment_id_deployments_id_fk" FOREIGN KEY ("latest_deployment_id") REFERENCES "deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_environments_environment_idx" ON "service_environments" USING btree ("environment_id");
