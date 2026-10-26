CREATE TABLE "epss_scores" (
	"cve_id" text PRIMARY KEY NOT NULL,
	"score_bp" integer NOT NULL,
	"percentile_bp" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
