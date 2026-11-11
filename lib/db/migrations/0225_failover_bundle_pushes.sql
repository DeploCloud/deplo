-- Which deployment's failover bundle each leader key holds for a cluster workload (spec #176, ADR-0045); a null pushed_at is not delivered yet.
CREATE TABLE IF NOT EXISTS "failover_bundle_pushes" (
	"workload_kind" text NOT NULL,
	"workload_id" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"deployment_id" text NOT NULL,
	"bundle_enc" text NOT NULL,
	"pushed_at" timestamp with time zone,
	CONSTRAINT "failover_bundle_pushes_workload_kind_workload_id_key_fingerprint_pk" PRIMARY KEY("workload_kind","workload_id","key_fingerprint")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "failover_bundle_pushes_key_idx" ON "failover_bundle_pushes" USING btree ("key_fingerprint");
